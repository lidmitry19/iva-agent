---- MODULE Proactive ----
\* Проактивность Ивы (спека .scratch/proactive, раздел 7): прогон по расписанию раз в полчаса
\* берёт замок без ожидания, читает data/proactive.json, при наступившем слоте ставит заявку
\* Brief и ведёт ход Brief, потом проверяет источники без модели, ставит заявку Watch
\* (reported: true, до хода), ведёт ход, доставляет части и после доставки пишет wakes.
\* Каждая запись состояния — целый объект из памяти прогона (saveJsonAtomic) и может не
\* удаться. Прогон может упасть на любом шаге; замок упавшего остаётся до протухания.
\*
\* Время. Шаг Tick — граница в 8 минут. Замок без сердцебиения: период staleMs/3 = 800 с
\* длиннее предохранителя LOCK_MAX_HOLD_MS = 600 с (agent/lib/fs-atomic.ts:823, 837, 864),
\* поэтому замок живёт staleMs от взятия. lockAge — сколько границ прошло с взятия:
\* реальный возраст >= 40 мин возможен только при lockAge >= 5, отсюда Stale = 5.
\* Живой прогон живёт не дольше timeoutMs + killGraceMs = 30 мин 10 с (SIGTERM группе, через
\* 10 с SIGKILL, agent/lib/schedule-runner.ts:582-595) и пересекает не больше 4 границ,
\* отсюда MaxRun = 4. При шаге 10 минут обе величины равнялись бы 4 и модель давала бы
\* ложную кражу замка. Срок живого держателя модель считает от взятия замка, а не от
\* старта: это длиннее жизни. Допущение: ребёнок не переживает раннер — юнит iva.service не
\* задаёт KillMode (scripts/cli/systemd.ts:221), по умолчанию control-group убивает всю группу.
\*
\* Атомарность. Взятие замка и чтение файла — один шаг (оба под замком). Проверка источников
\* и заявка — один шаг (проверка ограничена своими сроками 10 и 20 с, меньше шага Tick).
\* Ход и доставка — один шаг: обрыв между ними равен ходу без ответа. Снятие замка входит в
\* последний шаг прогона: обрыв после последней записи равен простою замка до протухания, а
\* такие поведения модель уже даёт (прогоны стартуют когда угодно).
\*
\* Вне модели (покрыто PBT спеки, раздел 6): staleMinutes, тихие часы и предел
\* modelWakesPerDay — только задерживают пункт; модель берёт ЛЮБОЕ подмножество допущенных
\* кандидатов, этим они и покрыты. Пункты check:<источник> и Signal ведут себя как обычный ключ
\* или не идут через этот прогон. Сбой (T3) — ключ failure:<юнит> вне заявки: источник отдаёт
\* его, пока выход новее failuresSeenUpToMs и дроссель Alert пропускает; дроссель, reported и
\* сдвиг failuresSeenUpToMs пишутся только после доставки всех частей (tick.ts:settleFailures),
\* обрыв раньше даёт повтор — для сбоя молчание хуже дубля, поведение мутанта Post. После
\* отметки ключ уходит из источника и возвращается «ростом» — сменой существа, через неделю или
\* после починки. Бронь раннера inProgressSince (второй слой)
\* не моделируется: прогоны стартуют когда угодно, это шире жизни.
\*
\* Действие модели -> код (Watch — T1, Brief — T2)
\*   Start            agent/schedules/proactive.ts (PROACTIVE_TICK_CRON) -> runScheduledJob ->
\*                    scripts/proactive/tick.ts:main (адресат; без него выход 0)
\*   TryLock          Ожидание до секунды (LOCK_WAIT_MS) равносильно более позднему TryLock:
\*                    взаимное исключение держит сам замок, модель от этого не меняется.
\*                    tick.ts:main: acquireFileLock(data/proactive.lock, { timeoutMs:
\*                    LOCK_WAIT_MS = 1 с, staleMs: LOCK_STALE_MS = 40 мин }) (agent/lib/fs-atomic.ts):
\*                    протухший забирается в том же вызове (с timeoutMs 0 — не всегда, срок
\*                    проверяется и на пути retry); занят живым — выход 0;
\*                    сразу под замком now = минута clock() (NowAfterLock = TRUE); затем
\*                    tick.ts:runProactiveTick -> readProactiveState (scripts/proactive/state.ts,
\*                    своё чтение по образцу readStatus: битый — выход 1, файл на месте)
\*   Tick, Timeout    время; срок runScheduledJob (timeoutMs 30 мин + killGraceMs 10 с)
\*   BClaim           runProactiveTick шаг 1: tick.ts:dueBrief (слоты в окне 3 ч, ход — по
\*                    последнему) -> tick.ts:brief, заявка briefDone (все наступившие) и
\*                    запись до хода; не записалось — хода Brief нет, дальше Watch, выход 1.
\*                    Код помечает наступившие в окне — подмножество rdue модели: слот вне
\*                    окна не наступит больше в этот день
\*   BTurn            tick.ts:brief: TickDeps.runTurn + tick.ts:deliver (слот 0 промолчал —
\*                    «Утро: новых дел нет»); провал хода — Brief нет, дальше Watch, выход 1
\*   Precheck         runProactiveTick: минута >= 30 (кроме первого прогона) — выход без
\*                    записи; tick.ts:watch: observe ->
\*                    Source.check (scripts/proactive/precheck.ts: telegramSource, mailSource,
\*                    failuresSource — systemctl, alertDue, alertResolved; ошибка — ключи
\*                    источника не трогаются, пункт check:<источник>, у отказа systemctl
\*                    без пункта) ->
\*                    tick.ts:observedState (state.ts:updateSeen) -> tick.ts:admit (фильтры) ->
\*                    пусто: запись seen;
\*                    иначе tick.ts:claim (обычным пунктам reported: true, modelWakes + 1;
\*                    сбои в заявку не входят) и запись состояния до хода.
\*                    Код берёт кандидатов только из увиденного в этот прогон — подмножество
\*                    того, что берёт модель
\*   Turn             tick.ts:wake: TickDeps.runTurn = runReminderTurn (scripts/lib/reminder-turn.ts)
\*                    + tick.ts:deliver (части по <!-- iva:next -->; QUIET и пусто — ничего,
\*                    а при сбое среди кандидатов tick.ts:toldParts шлёт строки note сбоев
\*                    одним сообщением и отмечает только их — вне модели, как отметка сбоев)
\*   Wakes            tick.ts:wake -> afterDelivery: запись wakes (state.ts:bump) после deliver,
\*                    если ушла хоть одна часть и в ходе был обычный пункт (дошли все части —
\*                    ещё и отметка сбоев, вне модели); отказ — строка в журнал
\*   Post             только мутант ClaimFirst = FALSE: заявка и wakes после хода
\*   снятие замка     releaseFileLock в finally tick.ts:main (входит в последний шаг)
\*   Crash            kill -9, обрыв питания, исключение между любыми шагами
\*   Arrive, ReadAll, ReadSome  подмена источника в tick.test.ts и tick.property.test.ts
\*                    (непрочитанное растёт, прочитано целиком, прочитано частично)
\*   SlotDue, NewDay  часы в зоне resolveTimeZone() (scripts/lib/timezone.ts), zonedParts
\*
\* Мутанты (свидетели): ClaimFirst = FALSE — заявка после хода; Locking = FALSE — без замка;
\* Capped = FALSE — без фильтра watchCapPerDay; Stale <= MaxRun — staleMs короче прогона.
EXTENDS Naturals, FiniteSets

CONSTANTS
  Procs,       \* прогоны, которые могут идти одновременно (модельные значения)
  Keys,        \* ключи источника (tg:<chat_id>, mail:<id>)
  Urgent,      \* срочные отправители, подмножество Keys
  NSlots,      \* слотов Brief в день
  MaxDays,     \* сколько дней
  MaxRuns,     \* сколько прогонов всего
  MaxArrive,   \* сколько раз растёт непрочитанное, всего
  MaxCrashes,  \* сколько падений
  Cap,         \* watchCapPerDay
  Stale,       \* staleMs в границах Tick
  MaxRun,      \* сколько границ Tick пересекает живой прогон
  Locking,     \* TRUE — замок есть
  ClaimFirst,  \* TRUE — заявка до хода
  Capped,      \* TRUE — фильтр wakes.count >= watchCapPerDay есть
  NowAfterLock \* TRUE — now прогона берётся сразу после взятия замка (правка спеки)

NoHolder == "none"
ASSUME Urgent \subseteq Keys /\ NoHolder \notin Procs

Slots == 1..NSlots
Days == 1..MaxDays
Gens == 0..MaxArrive
Section == {"bclaim", "bturn", "precheck", "turn", "wakes", "post"}
PCs == {"idle", "lock"} \cup Section
Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

VARIABLES
  src, gen, arrived,                         \* источник: непрочитанное и метка последнего роста
  day, due,                                  \* сегодня и наступившие слоты Brief
  fU, fRep, fGen, fWDay, fWCnt, fBDay, fBDone, \* data/proactive.json (fGen — призрак)
  holder, lockAge,                           \* data/proactive.lock
  pc, rday, rdue,                            \* прогон: шаг, день и слоты его now
  sU, sRep, sGen, sWDay, sWCnt, sBDay, sBDone, \* состояние в памяти прогона
  bslot, take, ord,                          \* слот Brief, пункты хода, был ли обычный пункт
  runs, crashes,
  took, dup, briefs, msgWakes, lost          \* призраки инвариантов

file == <<fU, fRep, fGen, fWDay, fWCnt, fBDay, fBDone>>
mem == <<sU, sRep, sGen, sWDay, sWCnt, sBDay, sBDone>>
env == <<src, gen, arrived, day, due>>
lock == <<holder, lockAge>>
local == <<rday, rdue, mem, bslot, take, ord>>
ghosts == <<took, dup, briefs, msgWakes, lost>>
vars == <<env, file, lock, pc, local, runs, crashes, ghosts>>

Init ==
  /\ src = [k \in Keys |-> 0] /\ gen = [k \in Keys |-> 0] /\ arrived = 0
  /\ day = 1 /\ due = {}
  /\ fU = [k \in Keys |-> 0] /\ fRep = [k \in Keys |-> FALSE] /\ fGen = [k \in Keys |-> 0]
  /\ fWDay = 0 /\ fWCnt = 0 /\ fBDay = 0 /\ fBDone = {}
  /\ holder = NoHolder /\ lockAge = 0
  /\ pc = [p \in Procs |-> "idle"]
  /\ rday = [p \in Procs |-> 1] /\ rdue = [p \in Procs |-> {}]
  /\ sU = [p \in Procs |-> [k \in Keys |-> 0]]
  /\ sRep = [p \in Procs |-> [k \in Keys |-> FALSE]]
  /\ sGen = [p \in Procs |-> [k \in Keys |-> 0]]
  /\ sWDay = [p \in Procs |-> 0] /\ sWCnt = [p \in Procs |-> 0]
  /\ sBDay = [p \in Procs |-> 0] /\ sBDone = [p \in Procs |-> {}]
  /\ bslot = [p \in Procs |-> 1] /\ take = [p \in Procs |-> {}] /\ ord = [p \in Procs |-> FALSE]
  /\ runs = 0 /\ crashes = 0
  /\ took = [k \in Keys |-> {}] /\ dup = FALSE
  /\ briefs = [x \in Days \X Slots |-> 0]
  /\ msgWakes = [d \in Days |-> 0] /\ lost = [d \in Days |-> 0]

\* Записать в файл целиком: seen из памяти прогона p, остальное — как передано.
Write(p, rep, wd, wc, bd, bdone) ==
  /\ fU' = sU[p] /\ fRep' = rep /\ fGen' = sGen[p]
  /\ fWDay' = wd /\ fWCnt' = wc /\ fBDay' = bd /\ fBDone' = bdone

\* Действующие счётчик дня и сделанные слоты в памяти прогона.
Eff(p) == IF sWDay[p] = rday[p] THEN sWCnt[p] ELSE 0
Done(p) == IF sBDay[p] = rday[p] THEN sBDone[p] ELSE {}

Goto(p, s) == pc' = [pc EXCEPT ![p] = s]

\* Конец прогона: снять свой замок (токен владельца, FileLock.tla) и уйти в простой.
Finish(p) ==
  /\ Goto(p, "idle")
  /\ IF Locking /\ holder = p
       THEN holder' = NoHolder /\ lockAge' = 0
       ELSE UNCHANGED lock

\* ---- Мир ----

Arrive(k) ==
  /\ arrived < MaxArrive
  /\ arrived' = arrived + 1
  /\ src' = [src EXCEPT ![k] = @ + 1] /\ gen' = [gen EXCEPT ![k] = arrived + 1]
  /\ UNCHANGED <<day, due, file, lock, pc, local, runs, crashes, ghosts>>

ReadAll(k) ==
  /\ src[k] > 0 /\ src' = [src EXCEPT ![k] = 0]
  /\ UNCHANGED <<gen, arrived, day, due, file, lock, pc, local, runs, crashes, ghosts>>

ReadSome(k) ==
  /\ src[k] > 1 /\ src' = [src EXCEPT ![k] = @ - 1]
  /\ UNCHANGED <<gen, arrived, day, due, file, lock, pc, local, runs, crashes, ghosts>>

SlotDue ==
  /\ due # Slots /\ due' = due \cup {Min(Slots \ due)}
  /\ UNCHANGED <<src, gen, arrived, day, file, lock, pc, local, runs, crashes, ghosts>>

NewDay ==
  /\ day < MaxDays /\ day' = day + 1 /\ due' = {}
  /\ UNCHANGED <<src, gen, arrived, file, lock, pc, local, runs, crashes, ghosts>>

\* Граница времени для взятого замка. Срок раннера срабатывает вовремя: живой держатель на
\* MaxRun дальше не стареет, его убивает Timeout.
Live(p) == pc[p] \in Section
Tick ==
  /\ holder # NoHolder /\ lockAge < Stale
  /\ ~(Live(holder) /\ lockAge >= MaxRun)
  /\ lockAge' = lockAge + 1
  /\ UNCHANGED <<env, file, holder, pc, local, runs, crashes, ghosts>>

\* ---- Прогон ----

\* Старт tick.ts. При NowAfterLock = FALSE (спека v4) now берётся здесь, до замка.
Start(p) ==
  /\ pc[p] = "idle" /\ runs < MaxRuns
  /\ runs' = runs + 1 /\ Goto(p, "lock")
  /\ rday' = [rday EXCEPT ![p] = day] /\ rdue' = [rdue EXCEPT ![p] = due]
  /\ take' = [take EXCEPT ![p] = {}] /\ ord' = [ord EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<env, file, lock, mem, bslot, crashes, ghosts>>

\* Без ожидания: свободен или протух — взят и файл прочитан; занят — выход 0.
\* При NowAfterLock = TRUE now прогона берётся здесь, сразу после взятия замка.
TryLock(p) ==
  /\ pc[p] = "lock"
  /\ IF ~Locking \/ holder = NoHolder \/ lockAge >= Stale
       THEN LET rd == IF NowAfterLock THEN day ELSE rday[p]
                ru == IF NowAfterLock THEN due ELSE rdue[p]
                done == IF fBDay = rd THEN fBDone ELSE {}
            IN /\ holder' = (IF Locking THEN p ELSE holder)
               /\ lockAge' = 0
               /\ rday' = [rday EXCEPT ![p] = rd] /\ rdue' = [rdue EXCEPT ![p] = ru]
               /\ sU' = [sU EXCEPT ![p] = fU] /\ sRep' = [sRep EXCEPT ![p] = fRep]
               /\ sGen' = [sGen EXCEPT ![p] = fGen]
               /\ sWDay' = [sWDay EXCEPT ![p] = fWDay] /\ sWCnt' = [sWCnt EXCEPT ![p] = fWCnt]
               /\ sBDay' = [sBDay EXCEPT ![p] = fBDay] /\ sBDone' = [sBDone EXCEPT ![p] = fBDone]
               /\ Goto(p, IF ru \ done # {} THEN "bclaim" ELSE "precheck")
       ELSE /\ UNCHANGED <<lock, mem, rday, rdue>> /\ Goto(p, "idle")
  /\ UNCHANGED <<env, file, bslot, take, ord, runs, crashes, ghosts>>

\* Заявка Brief до хода: все наступившие слоты помечены, ход — по последнему. Не записалось —
\* хода Brief нет, прогон идёт в Watch.
BClaim(p) ==
  /\ pc[p] = "bclaim"
  /\ LET nd == Done(p) \cup rdue[p]
         pend == rdue[p] \ Done(p)
     IN \/ /\ Write(p, sRep[p], sWDay[p], sWCnt[p], rday[p], nd)
           /\ sBDay' = [sBDay EXCEPT ![p] = rday[p]] /\ sBDone' = [sBDone EXCEPT ![p] = nd]
           /\ bslot' = [bslot EXCEPT ![p] = Max(pend)]
           /\ Goto(p, "bturn")
        \/ /\ UNCHANGED <<file, sBDay, sBDone, bslot>>
           /\ Goto(p, "precheck")
  /\ UNCHANGED <<env, lock, rday, rdue, sU, sRep, sGen, sWDay, sWCnt, take, ord, runs, crashes,
                 ghosts>>

\* Ход Brief и доставка: ответ (в том числе запасной текст слота 0) или провал; дальше Watch.
BTurn(p) ==
  /\ pc[p] = "bturn"
  /\ \/ briefs' = [briefs EXCEPT ![<<rday[p], bslot[p]>>] = @ + 1]
     \/ UNCHANGED briefs
  /\ Goto(p, "precheck")
  /\ UNCHANGED <<env, file, lock, local, runs, crashes, took, dup, msgWakes, lost>>

\* Обновление seen по шагу 4 спеки для одного ключа: s — непрочитанное в источнике,
\* u, r, g — запись в памяти, ng — метка роста в источнике.
NewRep(s, u, r) == IF s = 0 \/ u = 0 \/ s > u THEN FALSE ELSE r
NewGen(s, u, g, ng) == IF s = 0 THEN 0 ELSE IF u = 0 \/ s > u THEN ng ELSE g

\* Проверка перед ходом, фильтры и заявка. Минута не :00 — конец прогона. Ошибка
\* источника — его ключи не трогаются. Предел watchCapPerDay оставляет срочных. Остальные
\* фильтры (тихие часы, staleMinutes, modelWakesPerDay) лишь откладывают — модель берёт любое
\* подмножество. Заявка: кандидаты reported, запись целиком; пусто — только запись seen.
\* Запись не удалась — хода нет, прогон с ошибкой.
Precheck(p) ==
  /\ pc[p] = "precheck"
  /\ \/ /\ Finish(p)
        /\ UNCHANGED <<file, mem, take>>
     \/ \E err \in BOOLEAN :
          LET u2 == IF err THEN sU[p] ELSE src
              r2 == IF err THEN sRep[p] ELSE [k \in Keys |-> NewRep(src[k], sU[p][k], sRep[p][k])]
              g2 == IF err THEN sGen[p]
                    ELSE [k \in Keys |-> NewGen(src[k], sU[p][k], sGen[p][k], gen[k])]
              cand == {k \in Keys : u2[k] > 0 /\ ~r2[k]}
              allowed == IF Capped /\ Eff(p) >= Cap THEN cand \cap Urgent ELSE cand
          IN \E S \in SUBSET allowed :
               LET r3 == IF ClaimFirst THEN [k \in Keys |-> IF k \in S THEN TRUE ELSE r2[k]]
                         ELSE r2
               IN /\ sU' = [sU EXCEPT ![p] = u2] /\ sRep' = [sRep EXCEPT ![p] = r3]
                  /\ sGen' = [sGen EXCEPT ![p] = g2]
                  /\ take' = [take EXCEPT ![p] = S]
                  /\ \/ /\ fU' = u2 /\ fRep' = r3 /\ fGen' = g2
                        /\ fWDay' = sWDay[p] /\ fWCnt' = sWCnt[p]
                        /\ fBDay' = sBDay[p] /\ fBDone' = sBDone[p]
                        /\ IF S = {} THEN Finish(p) ELSE (Goto(p, "turn") /\ UNCHANGED lock)
                     \/ /\ UNCHANGED file
                        /\ Finish(p)
  /\ UNCHANGED <<env, rday, rdue, sWDay, sWCnt, sBDay, sBDone, bslot, ord, runs, crashes,
                 ghosts>>

\* Ход и доставка: пункты достались ходу (призрак took по метке роста). Ответ — ушла хоть одна
\* часть; обычный пункт (не срочный) — подъём с сообщением. QUIET, пусто или провал — ничего.
Turn(p) ==
  /\ pc[p] = "turn"
  /\ dup' = (dup \/ \E k \in take[p] : sGen[p][k] \in took[k])
  /\ took' = [k \in Keys |-> IF k \in take[p] THEN took[k] \cup {sGen[p][k]} ELSE took[k]]
  /\ \E sent \in BOOLEAN :
       LET o == sent /\ take[p] \ Urgent # {}
       IN /\ ord' = [ord EXCEPT ![p] = o]
          /\ msgWakes' = [msgWakes EXCEPT ![rday[p]] = @ + (IF o THEN 1 ELSE 0)]
          /\ IF ~ClaimFirst THEN Goto(p, "post") /\ UNCHANGED lock
             ELSE IF o THEN Goto(p, "wakes") /\ UNCHANGED lock
             ELSE Finish(p)
  /\ UNCHANGED <<env, file, rday, rdue, mem, bslot, take, runs, crashes, briefs, lost>>

\* Запись wakes после доставки. Не записалось — предел не вырос (строка в журнал).
Wakes(p) ==
  /\ pc[p] = "wakes"
  /\ \/ /\ Write(p, sRep[p], rday[p], Eff(p) + 1, sBDay[p], sBDone[p])
        /\ UNCHANGED lost
     \/ /\ lost' = [lost EXCEPT ![rday[p]] = @ + 1]
        /\ UNCHANGED file
  /\ Finish(p)
  /\ UNCHANGED <<env, local, runs, crashes, took, dup, briefs, msgWakes>>

\* Мутант ClaimFirst = FALSE: заявка и wakes одной записью после хода.
Post(p) ==
  /\ pc[p] = "post"
  /\ LET r2 == [k \in Keys |-> IF k \in take[p] THEN TRUE ELSE sRep[p][k]]
         wd == IF ord[p] THEN rday[p] ELSE sWDay[p]
         wc == IF ord[p] THEN Eff(p) + 1 ELSE sWCnt[p]
     IN \/ /\ Write(p, r2, wd, wc, sBDay[p], sBDone[p])
           /\ UNCHANGED lost
        \/ /\ lost' = [lost EXCEPT ![rday[p]] = @ + (IF ord[p] THEN 1 ELSE 0)]
           /\ UNCHANGED file
  /\ Finish(p)
  /\ UNCHANGED <<env, local, runs, crashes, took, dup, briefs, msgWakes>>

\* Подъём ушёл, а wakes не записан.
InWindow(p) == pc[p] = "wakes" \/ (pc[p] = "post" /\ ord[p])

\* Смерть прогона: замок остаётся до протухания.
Kill(p) ==
  /\ Goto(p, "idle")
  /\ lost' = IF InWindow(p) THEN [lost EXCEPT ![rday[p]] = @ + 1] ELSE lost
  /\ UNCHANGED <<env, file, lock, local, runs, took, dup, briefs, msgWakes>>

\* Падение на любом шаге.
Crash(p) ==
  /\ Live(p) /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ Kill(p)

\* Срок раннера: SIGTERM, затем SIGKILL группе.
Timeout(p) ==
  /\ Live(p) /\ holder = p /\ lockAge >= MaxRun
  /\ UNCHANGED crashes
  /\ Kill(p)

Next ==
  \/ \E k \in Keys : Arrive(k) \/ ReadAll(k) \/ ReadSome(k)
  \/ SlotDue \/ NewDay \/ Tick
  \/ \E p \in Procs :
       \/ Start(p) \/ TryLock(p) \/ BClaim(p) \/ BTurn(p) \/ Precheck(p) \/ Turn(p)
       \/ Wakes(p) \/ Post(p) \/ Crash(p) \/ Timeout(p)

Spec == Init /\ [][Next]_vars

\* Отпечаток состояния для TLC: в него входит только та память прогона, которую прочтёт
\* следующий шаг. Остальная мертва: Start и TryLock перезаписывают её до чтения, rdue читает
\* только BClaim, bslot — только BTurn, take — Turn и Post, ord — Post. Без этого одинаковые
\* по будущему состояния различались бы мусором, а число состояний зависело бы от порядка обхода.
Local(p) ==
  CASE pc[p] = "idle" -> <<>>
    [] pc[p] = "lock" -> IF NowAfterLock THEN <<>> ELSE <<rday[p], rdue[p]>>
    [] OTHER -> <<rday[p], IF pc[p] = "bclaim" THEN rdue[p] ELSE {},
                  sU[p], sRep[p], sGen[p], sWDay[p], sWCnt[p], sBDay[p], sBDone[p],
                  IF pc[p] = "bturn" THEN bslot[p] ELSE 0,
                  IF pc[p] \in {"turn", "post"} THEN take[p] ELSE {},
                  IF pc[p] = "post" THEN ord[p] ELSE FALSE>>
View == <<env, file, lock, pc, [p \in Procs |-> Local(p)], runs, crashes, ghosts>>

TypeOK ==
  /\ src \in [Keys -> 0..MaxArrive] /\ gen \in [Keys -> Gens] /\ arrived \in 0..MaxArrive
  /\ day \in Days /\ due \subseteq Slots
  /\ fU \in [Keys -> 0..MaxArrive] /\ fRep \in [Keys -> BOOLEAN] /\ fGen \in [Keys -> Gens]
  /\ fWDay \in 0..MaxDays /\ fWCnt \in Nat /\ fBDay \in 0..MaxDays /\ fBDone \subseteq Slots
  /\ holder \in Procs \cup {NoHolder} /\ lockAge \in 0..Stale
  /\ pc \in [Procs -> PCs]
  /\ take \in [Procs -> SUBSET Keys] /\ ord \in [Procs -> BOOLEAN]
  /\ runs \in 0..MaxRuns /\ crashes \in 0..MaxCrashes
  /\ took \in [Keys -> SUBSET Gens] /\ dup \in BOOLEAN

\* (1) Ключ достаётся не больше чем одному ходу между ростами unread: два хода с одной
\* меткой роста — дубль.
NoDoubleTake == ~dup

\* (2) Один Brief на слот.
OneBriefPerSlot == \A x \in Days \X Slots : briefs[x] <= 1

\* (3) Подъёмов с сообщением от обычных пунктов за день не больше предела плюс число
\* обрывов между доставкой и записью wakes.
WakesCapped == \A d \in Days : msgWakes[d] <= Cap + lost[d]

\* (4) Два прогона не идут одновременно.
OneRun == Cardinality({p \in Procs : Live(p)}) <= 1
====
