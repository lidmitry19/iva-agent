---- MODULE PluginProposal ----
\* Жизненный цикл предложения плагина (ADR-0009). Модель написана ПОСЛЕ кода и проверяет
\* код, не дизайн: каждое действие — шаг существующей функции (карта ниже).
\*
\* Одна кнопка — один хеш дерева d (первые 12 знаков). Папки на диске:
\*   P — предложение data/plugin-proposals/<name>-<d>/, T — забранная копия .taken-<d>/.
\* У папки есть время (mtime: propose ставит его при claim и utimes, тап — при заборе) и
\* содержимое: good — байты с хешем d, bad — второй писатель (bash модели) поменял файлы.
\* Staging propose и staging установщика — свои папки mkdtemp со случайным именем; второй
\* писатель их не знает, и модель их не трогает (честная оговорка ADR-0009: модель с `bash`
\* может поставить что угодно мимо CLI, тап — граница намерения, не защита от взлома).
\* Изменённый исходник даёт другой хеш, то есть другую кнопку, — вне модели.
\*
\* Bridge. Оба тапа идут в одном процессе Node: renameSync, ageMs и stamp в takeProposal
\* стоят без await между ними, поэтому второй тап не вклинивается, пока первый в шаге
\* "renamed" (BridgeFree). Другие процессы (propose, установщик, второй писатель) — могут.
\* Без этого условия TLC даёт контрпример: тап A забрал старую копию, уборка её снесла,
\* новый propose и тап B положили свежую T, и A ставит время и считает своей чужую копию —
\* два держателя одной T. Вставить await между rename и stamp — открыть эту гонку.
\*
\* Время. Clock — граница; TTL — сутки (PROPOSAL_TTL_MS) в границах. Уборка удаляет папку,
\* чей возраст больше TTL. Допущение: держатель забранной копии (тап до запуска, установщик)
\* живёт меньше суток — Tick не уводит часы на TTL от его тапа (сборка и рестарт идут минуты).
\*
\* Действие модели -> код
\*   Begin       scripts/cli/plugin-cli-proposal.ts:propose — sweepProposals
\*               (scripts/lib/plugin-proposal.ts), затем копия в staging и хеш
\*   Claim       propose: claimFolder — rename staging -> P; P уже есть — переиспользуется
\*   StampP      propose: utimesSync(target); P забрали между claim и utimes — исключение
\*   SendOk/Fail propose: отправка; отказ — rm P, если её создал этот propose
\*   TakeRename  scripts/lib/plugin-proposal.ts:takeProposal — renameSync(P, T); P нет или T
\*               занята (ENOTEMPTY) — «устарело»
\*   TakeStamp   takeProposal: ageMs(T) <= TTL, затем stamp(T) — время тапа; не свежо — rm T
\*   TakeHash    takeProposal: digestOf(T) = d; не совпало — rm T
\*   LaunchOk    scripts/poller/plugin-proposal-tap.ts: launchIvaCommand -> installProposal
\*   LaunchFail  tap: запуск не удался — returnProposal (rename T -> P; P есть — не вернуть)
\*   Check1      scripts/cli/plugin-cli-proposal.ts:installProposal — первая сверка хеша T
\*   Copy        scripts/cli/plugin-cli-install.ts:install -> stage — копия T в staging
\*   Check2      install -> sameAsButton — хеш staged-копии = d
\*   Install     install -> swapIntoStore(staged) — в стор идут байты staging; плагин уже
\*               стоит — отказ «already installed»
\*   Finish      installProposal: rmSync(T) и сообщение владельцу; любой отказ выше — тоже сюда
\*   Tamper      второй писатель меняет файлы P или T
\*   Crash       kill -9, обрыв питания, исключение между любыми шагами любого процесса
\*
\* Мутанты (свидетели): ExclusiveTake = FALSE — тап копирует P, а не забирает rename;
\* StampOnTake = FALSE — T хранит время propose (код до ремонта); StagedCheck = FALSE —
\* установщик сверяет только T и ставит копию без второй сверки (код до ремонта).
EXTENDS Naturals, FiniteSets

CONSTANTS
  NProps,        \* сколько propose одного содержимого
  NTaps,         \* сколько тапов кнопки
  TTL,           \* сутки в границах Tick
  MaxClock,      \* сколько границ
  MaxTamper,     \* сколько правок второго писателя
  ExclusiveTake, \* TRUE — тап забирает rename
  StampOnTake,   \* TRUE — тап ставит копии время тапа
  StagedCheck    \* TRUE — установщик сверяет хеш staged-копии

Props == 1..NProps
Taps == 1..NTaps
PrPhases == {"idle", "staged", "claimed", "stamped", "done"}
TapPhases == {"idle", "renamed", "stamped", "taken", "done"}
Running == {"launched", "checked", "copied", "verified", "installed"}
InstPhases == {"none", "done"} \cup Running

VARIABLES
  clock,
  pIn, pGood, pTs,   \* P: есть ли, байты, время
  tIn, tGood, tTs,   \* T: есть ли, байты, время
  pr, created,       \* propose: шаг, создал ли он P
  tp, since,         \* тап: шаг, время тапа
  inst, sGood,       \* установщик тапа: шаг, байты его staging
  store,             \* стор: none | good | bad
  tampers

vars == <<clock, pIn, pGood, pTs, tIn, tGood, tTs, pr, created, tp, since, inst, sGood,
          store, tampers>>

Init ==
  /\ clock = 0
  /\ pIn = FALSE /\ pGood = TRUE /\ pTs = 0
  /\ tIn = FALSE /\ tGood = TRUE /\ tTs = 0
  /\ pr = [q \in Props |-> "idle"] /\ created = [q \in Props |-> FALSE]
  /\ tp = [i \in Taps |-> "idle"] /\ since = [i \in Taps |-> 0]
  /\ inst = [i \in Taps |-> "none"] /\ sGood = [i \in Taps |-> TRUE]
  /\ store = "none"
  /\ tampers = 0

\* Держатель забранной копии: тап между забором и запуском, живой установщик.
Holds(i) == tp[i] \in {"stamped", "taken"} \/ inst[i] \in Running

\* Удалить T (rmSync force): пустое место сбрасывается, чтобы не плодить состояния.
DropT == tIn' = FALSE /\ tGood' = TRUE /\ tTs' = 0
DropP == pIn' = FALSE /\ pGood' = TRUE /\ pTs' = 0
KeepT == UNCHANGED <<tIn, tGood, tTs>>
KeepP == UNCHANGED <<pIn, pGood, pTs>>
Old(ts) == clock > ts + TTL

\* Синхронный участок takeProposal другого тапа не прерывается (см. шапку).
BridgeFree(i) == \A j \in Taps \ {i} : tp[j] # "renamed"

Tick ==
  /\ clock < MaxClock
  /\ \A i \in Taps : Holds(i) => clock + 1 < since[i] + TTL
  /\ clock' = clock + 1
  /\ UNCHANGED <<pIn, pGood, pTs, tIn, tGood, tTs, pr, created, tp, since, inst, sGood,
                 store, tampers>>

\* ── propose ──

Begin(q) ==
  /\ pr[q] = "idle"
  /\ IF pIn /\ Old(pTs) THEN DropP ELSE KeepP
  /\ IF tIn /\ Old(tTs) THEN DropT ELSE KeepT
  /\ pr' = [pr EXCEPT ![q] = "staged"]
  /\ UNCHANGED <<clock, created, tp, since, inst, sGood, store, tampers>>

Claim(q) ==
  /\ pr[q] = "staged"
  /\ IF pIn
       THEN created' = [created EXCEPT ![q] = FALSE] /\ KeepP
       ELSE created' = [created EXCEPT ![q] = TRUE]
            /\ pIn' = TRUE /\ pGood' = TRUE /\ pTs' = clock
  /\ pr' = [pr EXCEPT ![q] = "claimed"]
  /\ UNCHANGED <<clock, tIn, tGood, tTs, tp, since, inst, sGood, store, tampers>>

StampP(q) ==
  /\ pr[q] = "claimed"
  /\ IF pIn
       THEN pTs' = clock /\ pr' = [pr EXCEPT ![q] = "stamped"]
       ELSE pTs' = pTs /\ pr' = [pr EXCEPT ![q] = "done"]
  /\ UNCHANGED <<clock, pIn, pGood, tIn, tGood, tTs, created, tp, since, inst, sGood,
                 store, tampers>>

SendOk(q) ==
  /\ pr[q] = "stamped"
  /\ pr' = [pr EXCEPT ![q] = "done"]
  /\ UNCHANGED <<clock, pIn, pGood, pTs, tIn, tGood, tTs, created, tp, since, inst, sGood,
                 store, tampers>>

SendFail(q) ==
  /\ pr[q] = "stamped"
  /\ IF created[q] THEN DropP ELSE KeepP
  /\ pr' = [pr EXCEPT ![q] = "done"]
  /\ UNCHANGED <<clock, tIn, tGood, tTs, created, tp, since, inst, sGood, store, tampers>>

\* ── тап в Bridge ──

TakeRename(i) ==
  /\ tp[i] = "idle"
  /\ BridgeFree(i)
  /\ IF pIn /\ (~tIn \/ ~ExclusiveTake)
       THEN /\ tIn' = TRUE /\ tGood' = pGood /\ tTs' = pTs
            /\ IF ExclusiveTake THEN DropP ELSE KeepP
            /\ tp' = [tp EXCEPT ![i] = "renamed"]
       ELSE KeepP /\ KeepT /\ tp' = [tp EXCEPT ![i] = "done"]
  /\ UNCHANGED <<clock, pr, created, since, inst, sGood, store, tampers>>

TakeStamp(i) ==
  /\ tp[i] = "renamed"
  /\ IF tIn /\ ~Old(tTs)
       THEN /\ tTs' = IF StampOnTake THEN clock ELSE tTs
            /\ UNCHANGED <<tIn, tGood>>
            /\ since' = [since EXCEPT ![i] = clock]
            /\ tp' = [tp EXCEPT ![i] = "stamped"]
       ELSE DropT /\ since' = since /\ tp' = [tp EXCEPT ![i] = "done"]
  /\ UNCHANGED <<clock, pIn, pGood, pTs, pr, created, inst, sGood, store, tampers>>

TakeHash(i) ==
  /\ tp[i] = "stamped"
  /\ BridgeFree(i)
  /\ IF tIn /\ tGood
       THEN KeepT /\ tp' = [tp EXCEPT ![i] = "taken"]
       ELSE DropT /\ tp' = [tp EXCEPT ![i] = "done"]
  /\ UNCHANGED <<clock, pIn, pGood, pTs, pr, created, since, inst, sGood, store, tampers>>

LaunchOk(i) ==
  /\ tp[i] = "taken"
  /\ BridgeFree(i)
  /\ tp' = [tp EXCEPT ![i] = "done"]
  /\ inst' = [inst EXCEPT ![i] = "launched"]
  /\ UNCHANGED <<clock, pIn, pGood, pTs, tIn, tGood, tTs, pr, created, since, sGood, store,
                 tampers>>

LaunchFail(i) ==
  /\ tp[i] = "taken"
  /\ BridgeFree(i)
  /\ IF tIn /\ ~pIn
       THEN pIn' = TRUE /\ pGood' = tGood /\ pTs' = tTs /\ DropT
       ELSE KeepP /\ KeepT
  /\ tp' = [tp EXCEPT ![i] = "done"]
  /\ UNCHANGED <<clock, pr, created, since, inst, sGood, store, tampers>>

\* ── установщик ──

Fail(i) ==
  /\ DropT
  /\ inst' = [inst EXCEPT ![i] = "done"]

Check1(i) ==
  /\ inst[i] = "launched"
  /\ IF tIn /\ tGood THEN KeepT /\ inst' = [inst EXCEPT ![i] = "checked"] ELSE Fail(i)
  /\ UNCHANGED <<clock, pIn, pGood, pTs, pr, created, tp, since, sGood, store, tampers>>

Copy(i) ==
  /\ inst[i] = "checked"
  /\ IF tIn
       THEN KeepT /\ sGood' = [sGood EXCEPT ![i] = tGood]
            /\ inst' = [inst EXCEPT ![i] = "copied"]
       ELSE Fail(i) /\ sGood' = sGood
  /\ UNCHANGED <<clock, pIn, pGood, pTs, pr, created, tp, since, store, tampers>>

Check2(i) ==
  /\ inst[i] = "copied"
  /\ IF sGood[i] \/ ~StagedCheck
       THEN KeepT /\ inst' = [inst EXCEPT ![i] = "verified"]
       ELSE Fail(i)
  /\ UNCHANGED <<clock, pIn, pGood, pTs, pr, created, tp, since, sGood, store, tampers>>

Install(i) ==
  /\ inst[i] = "verified"
  /\ IF store = "none"
       THEN /\ store' = IF sGood[i] THEN "good" ELSE "bad"
            /\ KeepT /\ inst' = [inst EXCEPT ![i] = "installed"]
       ELSE store' = store /\ Fail(i)
  /\ UNCHANGED <<clock, pIn, pGood, pTs, pr, created, tp, since, sGood, tampers>>

Finish(i) ==
  /\ inst[i] = "installed"
  /\ Fail(i)
  /\ UNCHANGED <<clock, pIn, pGood, pTs, pr, created, tp, since, sGood, store, tampers>>

\* ── второй писатель и обрывы ──

Tamper ==
  /\ tampers < MaxTamper
  /\ tampers' = tampers + 1
  /\ \/ pIn /\ pGood /\ pGood' = FALSE /\ UNCHANGED <<pIn, pTs>> /\ KeepT
     \/ tIn /\ tGood /\ tGood' = FALSE /\ UNCHANGED <<tIn, tTs>> /\ KeepP
  /\ UNCHANGED <<clock, pr, created, tp, since, inst, sGood, store>>

Crash ==
  /\ \/ \E q \in Props : pr[q] \in {"staged", "claimed", "stamped"}
          /\ pr' = [pr EXCEPT ![q] = "done"] /\ UNCHANGED <<tp, inst>>
     \/ \E i \in Taps : tp[i] \in {"renamed", "stamped", "taken"}
          /\ tp' = [tp EXCEPT ![i] = "done"] /\ UNCHANGED <<pr, inst>>
     \/ \E i \in Taps : inst[i] \in Running
          /\ inst' = [inst EXCEPT ![i] = "done"] /\ UNCHANGED <<pr, tp>>
  /\ UNCHANGED <<clock, pIn, pGood, pTs, tIn, tGood, tTs, created, since, sGood, store,
                 tampers>>

Next ==
  \/ Tick \/ Tamper \/ Crash
  \/ \E q \in Props : Begin(q) \/ Claim(q) \/ StampP(q) \/ SendOk(q) \/ SendFail(q)
  \/ \E i \in Taps : \/ TakeRename(i) \/ TakeStamp(i) \/ TakeHash(i)
                     \/ LaunchOk(i) \/ LaunchFail(i)
                     \/ Check1(i) \/ Copy(i) \/ Check2(i) \/ Install(i) \/ Finish(i)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ clock \in 0..MaxClock
  /\ pIn \in BOOLEAN /\ pGood \in BOOLEAN /\ pTs \in 0..MaxClock
  /\ tIn \in BOOLEAN /\ tGood \in BOOLEAN /\ tTs \in 0..MaxClock
  /\ pr \in [Props -> PrPhases] /\ created \in [Props -> BOOLEAN]
  /\ tp \in [Taps -> TapPhases] /\ since \in [Taps -> 0..MaxClock]
  /\ inst \in [Taps -> InstPhases] /\ sGood \in [Taps -> BOOLEAN]
  /\ store \in {"none", "good", "bad"}
  /\ tampers \in 0..MaxTamper

\* (1) Не больше одного живого установщика на предложение.
OneInstaller == Cardinality({i \in Taps : inst[i] \in Running}) <= 1

\* (2) В стор попадают только байты с хешем из кнопки.
OnlyButtonBytes == store # "bad"

\* (3) Уборщик не удаляет забранную копию, пока её держат (в пределах суток от тапа).
SweepSparesTaken == \A i \in Taps : Holds(i) => tIn
====
