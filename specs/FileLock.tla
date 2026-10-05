---------------------------- MODULE FileLock ----------------------------
(***************************************************************************)
(* Файловый замок agent/lib/fs-atomic.ts как он написан: attemptLock,      *)
(* inspectOccupiedLock, releaseFileLock, петля acquireFileLock.             *)
(*                                                                         *)
(* Замок — папка на пути; её поколение (inode) — номер dir, 0 = папки нет. *)
(* Владение — owner-файл с токеном попытки внутри папки (ents). Каждая     *)
(* файловая операция кода — один атомарный шаг; всё, что код делает по     *)
(* пути (readdir, rm, rmdir, open "wx"), попадает в ТЕКУЩУЮ папку, что бы  *)
(* процесс ни открыл раньше. Время — явный счётчик age: сколько тиков      *)
(* прошло с последнего изменения папки (mtime); папка протухла, когда      *)
(* age >= Stale. Процесс может упасть на любом шаге (Crash), его owner-файл *)
(* остаётся.                                                               *)
(*                                                                         *)
(* Время идёт свободно. Каждое допущение о нём — явная константа:        *)
(* - синхронные шаги attemptLock и release короче staleMs (контракт кода: *)
(*   они не отпускают event loop);                                         *)
(* - MaxSection: сколько тиков живой держатель может провести в секции    *)
(*   (0 — секция быстрее тика);                                            *)
(* - Heartbeat = TRUE: асинхронный acquireFileLock, таймер держателя       *)
(*   созревает раз в Period тиков, а колбэк (lstat своего owner-файла,     *)
(*   utimes папки) выполняется не позже чем через MaxLag тиков после       *)
(*   созревания. MaxLag — допущение о среде (event loop держателя), не     *)
(*   свойство кода: время в модели ждёт просроченный колбэк (Tick), а в    *)
(*   жизни — нет. FALSE: acquireFileLockSync, сердцебиения нет;            *)
(* - MaxHold: после стольких тиков удержания сердцебиение гаснет           *)
(*   (предохранитель LOCK_MAX_HOLD_MS).                                     *)
(* Граница: при Period + MaxLag < Stale и MaxSection < MaxHold инварианты  *)
(* держатся; MaxLag >= Stale - Period или MaxSection >= MaxHold дают       *)
(* ожидаемую кражу (FileLock-lag.cfg, FileLock-hold.cfg). Свидетель NotSlow *)
(* (FileLock-witness.cfg) обязан нарушаться: иначе время в модели стоит и  *)
(* безопасность держится не на сердцебиении, а на остановке времени.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Procs,      \* претенденты
  MaxTries,   \* сколько раз один вызов может создать папку (mkdir успешен)
  MaxCrashes, \* сколько падений за прогон
  Stale,      \* staleMs в тиках: папка протухла, когда age >= Stale
  MaxSection, \* сколько тиков живой держатель может провести в секции
  Deadline,   \* у вызова есть дедлайн (timeoutMs): он может вернуть null
  Heartbeat,  \* держатель бьётся: обновляет mtime своей папки
  Period,     \* период таймера сердцебиения (staleMs/3) в тиках
  MaxLag,     \* задержка колбэка после созревания таймера, в тиках
  MaxHold     \* после стольких тиков удержания сердцебиение гаснет

NoTok == <<0, 0>>
Tokens == Procs \X (1..MaxTries)

VARIABLES
  dir, nextGen,  \* текущее поколение папки (0 = нет) и счётчик поколений
  ents,          \* owner-файлы (токены) в текущей папке
  age,           \* тики с последнего изменения текущей папки (mtime), до Stale
  pc, alive, tries, tok,
  mkGen,         \* поколение, которое создал своим mkdir текущий заход (0 — не создавал)
  g1, gfd, cur,  \* lstat до open, поколение открытого fd, повторный lstat
  stale0,        \* протухла ли папка по первому lstat (inspectOccupiedLock)
  names,         \* снимок readdir
  toRm,          \* токены из снимка, которые уборка ещё удалит
  heldTok, heldGen,
  crashes,
  stolenLive,    \* чей-то шаг удалил owner-файл живого держателя (инвариант 2)
  hb,            \* колбэк сердцебиения: "idle" или "checked" (owner-файл на месте)
  since,         \* тики с последнего касания (или захвата): таймер созрел при >= Period
  held           \* тики в секции: предохранитель и контракт длины секции

vars == <<dir, nextGen, ents, age, pc, alive, tries, tok, mkGen, g1, gfd, cur,
          stale0, names, toRm, heldTok, heldGen, crashes, stolenLive, hb, since, held>>
local == <<tries, tok, mkGen, g1, gfd, cur, stale0, names, toRm, heldTok, heldGen, since, held>>

IsStale == age >= Stale
Owner(t) == t[1]

AStates == {"a_lstat", "a_open", "a_owner", "a_cur", "a_ownstat", "a_readdir"}
CStates == {"c_rmown", "c_rmdir"}
IStates == {"i_lstat", "i_open", "i_readdir", "i_cur", "i_rm", "i_rmdir"}
HStates == {"cs", "r_rmown", "r_rmdir"}

Init ==
  /\ dir = 0 /\ nextGen = 0 /\ ents = {} /\ age = 0
  /\ pc = [p \in Procs |-> "start"]
  /\ alive = [p \in Procs |-> TRUE]
  /\ tries = [p \in Procs |-> 0]
  /\ tok = [p \in Procs |-> NoTok]
  /\ mkGen = [p \in Procs |-> 0]
  /\ g1 = [p \in Procs |-> 0] /\ gfd = [p \in Procs |-> 0] /\ cur = [p \in Procs |-> 0]
  /\ stale0 = [p \in Procs |-> FALSE]
  /\ names = [p \in Procs |-> {}] /\ toRm = [p \in Procs |-> {}]
  /\ heldTok = [p \in Procs |-> NoTok] /\ heldGen = [p \in Procs |-> 0]
  /\ crashes = 0 /\ stolenLive = FALSE
  /\ hb = [p \in Procs |-> "idle"]
  /\ since = [p \in Procs |-> 0] /\ held = [p \in Procs |-> 0]

Go(p, l) == pc' = [pc EXCEPT ![p] = l]

\* Путевое удаление owner-файла (removeOwnedLockName): rm -f в текущей папке.
RmOwner(p, t) ==
  IF dir # 0 /\ t \in ents
  THEN /\ ents' = ents \ {t} /\ age' = 0
       /\ stolenLive' = (stolenLive \/ \E q \in Procs \ {p} :
                           alive[q] /\ pc[q] = "cs" /\ heldTok[q] = t)
  ELSE UNCHANGED <<ents, age, stolenLive>>

\* rmdir текущей папки (removeEmptyLockDirectory): проходит только для пустой.
\* Путевой: может снести и свежую пустую папку живого претендента — контракт (а).
Rmdir(p) ==
  IF dir # 0 /\ ents = {} THEN dir' = 0 ELSE UNCHANGED dir

----------------------------------------------------------------------------
(* Петля acquireFileLock: новая попытка attemptLock. Токен новый у каждой  *)
(* попытки; mkdir либо создаёт папку, либо (EEXIST) ведёт в inspect.       *)
Start(p) ==
  /\ pc[p] = "start"
  /\ IF dir = 0
     THEN IF tries[p] < MaxTries
          THEN /\ tries' = [tries EXCEPT ![p] = @ + 1]
               /\ tok' = [tok EXCEPT ![p] = <<p, tries[p] + 1>>]
               /\ nextGen' = nextGen + 1 /\ dir' = nextGen + 1
               /\ ents' = {} /\ age' = 0
               /\ mkGen' = [mkGen EXCEPT ![p] = nextGen + 1]
               /\ Go(p, "a_lstat")
               /\ UNCHANGED <<g1, gfd, cur, stale0, names, toRm, heldTok, heldGen, since, held>>
          ELSE /\ Go(p, "bounded")   \* модельная граница числа папок одного вызова
               /\ UNCHANGED <<nextGen, dir, ents, age, local>>
     ELSE /\ mkGen' = [mkGen EXCEPT ![p] = 0]
          /\ Go(p, "i_lstat")
          /\ UNCHANGED <<nextGen, dir, ents, age, tries, tok, g1, gfd, cur,
                         stale0, names, toRm, heldTok, heldGen, since, held>>
  /\ UNCHANGED <<alive, crashes, stolenLive>>

\* Дедлайн проверяется после каждой попытки, на пути busy и на пути retry.
Timeout(p) ==
  /\ Deadline /\ pc[p] = "start"
  /\ Go(p, "done")
  /\ UNCHANGED <<dir, nextGen, ents, age, alive, local, crashes, stolenLive, hb>>

\* Ошибка внутри attemptLock после mkdir: catch — уборка своего токена и rmdir.
Catch(p) == Go(p, "c_rmown")

Keep(p) == UNCHANGED <<dir, nextGen, ents, age, alive, crashes, stolenLive>>

ALstat(p) ==
  /\ pc[p] = "a_lstat"
  /\ IF dir = 0 THEN Catch(p) /\ UNCHANGED g1
     ELSE g1' = [g1 EXCEPT ![p] = dir] /\ Go(p, "a_open")
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, gfd, cur, stale0, names, toRm, heldTok, heldGen, since, held>>

AOpen(p) ==
  /\ pc[p] = "a_open"
  /\ IF dir = 0 THEN Catch(p) /\ UNCHANGED gfd
     ELSE /\ gfd' = [gfd EXCEPT ![p] = dir]
          \* другая папка, чем по lstat: return "retry" без уборки
          /\ Go(p, IF g1[p] # dir THEN "start" ELSE "a_owner")
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, g1, cur, stale0, names, toRm, heldTok, heldGen, since, held>>

\* openSync(ownerPath, "wx") — путевой: owner-файл попадает в текущую папку.
AOwner(p) ==
  /\ pc[p] = "a_owner"
  /\ IF dir = 0
     THEN Catch(p) /\ UNCHANGED <<ents, age>>
     ELSE ents' = ents \cup {tok[p]} /\ age' = 0 /\ Go(p, "a_cur")
  /\ UNCHANGED <<dir, nextGen, alive, crashes, stolenLive, local>>

ACur(p) ==
  /\ pc[p] = "a_cur"
  /\ IF dir = 0 THEN Catch(p) /\ UNCHANGED cur
     ELSE cur' = [cur EXCEPT ![p] = dir] /\ Go(p, "a_ownstat")
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, g1, gfd, stale0, names, toRm, heldTok, heldGen, since, held>>

AOwnStat(p) ==
  /\ pc[p] = "a_ownstat"
  /\ IF dir = 0 \/ tok[p] \notin ents THEN Catch(p) ELSE Go(p, "a_readdir")
  /\ Keep(p) /\ UNCHANGED local

\* readdir и итоговая проверка: та же папка, один owner-файл — свой.
AReaddir(p) ==
  /\ pc[p] = "a_readdir"
  /\ IF dir = 0 THEN Catch(p) /\ UNCHANGED <<heldTok, heldGen, since, held>>
     ELSE IF gfd[p] = cur[p] /\ ents = {tok[p]}
          THEN /\ heldTok' = [heldTok EXCEPT ![p] = tok[p]]
               /\ heldGen' = [heldGen EXCEPT ![p] = gfd[p]]
               /\ since' = [since EXCEPT ![p] = 0] /\ held' = [held EXCEPT ![p] = 0]
               /\ Go(p, "cs")
          ELSE Catch(p) /\ UNCHANGED <<heldTok, heldGen, since, held>>
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, g1, gfd, cur, stale0, names, toRm>>

CRmOwn(p) ==
  /\ pc[p] = "c_rmown"
  /\ RmOwner(p, tok[p]) /\ Go(p, "c_rmdir")
  /\ UNCHANGED <<dir, nextGen, alive, crashes, local>>

CRmdir(p) ==
  /\ pc[p] = "c_rmdir"
  /\ Rmdir(p) /\ Go(p, "start")
  /\ UNCHANGED <<nextGen, ents, age, alive, crashes, stolenLive, local>>

----------------------------------------------------------------------------
(* inspectOccupiedLock: папка занята (EEXIST).                             *)
ILstat(p) ==
  /\ pc[p] = "i_lstat"
  /\ IF dir = 0 THEN Go(p, "start") /\ UNCHANGED <<g1, stale0>>
     ELSE /\ g1' = [g1 EXCEPT ![p] = dir]
          /\ stale0' = [stale0 EXCEPT ![p] = IsStale]
          /\ Go(p, "i_open")
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, gfd, cur, names, toRm, heldTok, heldGen, since, held>>

IOpen(p) ==
  /\ pc[p] = "i_open"
  /\ IF dir = 0 THEN Go(p, "start") /\ UNCHANGED gfd
     ELSE /\ gfd' = [gfd EXCEPT ![p] = dir]
          /\ Go(p, IF g1[p] # dir THEN "start" ELSE "i_readdir")
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, g1, cur, stale0, names, toRm, heldTok, heldGen, since, held>>

\* readdirSync(path) — путевой: снимок текущей папки. Не протухла по первому
\* lstat — busy.
IReaddir(p) ==
  /\ pc[p] = "i_readdir"
  /\ IF dir = 0 THEN Go(p, "start") /\ UNCHANGED names
     ELSE /\ names' = [names EXCEPT ![p] = ents]
          /\ Go(p, IF stale0[p] THEN "i_cur" ELSE "start")
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, g1, gfd, cur, stale0, toRm, heldTok, heldGen, since, held>>

\* Повторный lstat: та же папка, что открыта, и всё ещё протухла — уборка
\* ровно тех токенов, что видел readdir (один или несколько — одинаково).
ICur(p) ==
  /\ pc[p] = "i_cur"
  /\ IF dir = 0 \/ dir # gfd[p] \/ ~IsStale
     THEN Go(p, "start") /\ UNCHANGED toRm
     ELSE toRm' = [toRm EXCEPT ![p] = names[p]] /\ Go(p, "i_rm")
  /\ Keep(p) /\ UNCHANGED <<tries, tok, mkGen, g1, gfd, cur, stale0, names, heldTok, heldGen, since, held>>

IRm(p) ==
  /\ pc[p] = "i_rm"
  /\ IF toRm[p] = {}
     THEN Go(p, "i_rmdir") /\ UNCHANGED <<ents, age, stolenLive, toRm>>
     ELSE \E t \in toRm[p] :
            /\ RmOwner(p, t)
            /\ toRm' = [toRm EXCEPT ![p] = @ \ {t}]
            /\ UNCHANGED pc
  /\ UNCHANGED <<dir, nextGen, alive, crashes,
                 tries, tok, mkGen, g1, gfd, cur, stale0, names, heldTok, heldGen, since, held>>

IRmdir(p) ==
  /\ pc[p] = "i_rmdir"
  /\ Rmdir(p) /\ Go(p, "start")
  /\ UNCHANGED <<nextGen, ents, age, alive, crashes, stolenLive, local>>

----------------------------------------------------------------------------
(* Держатель: критическая секция и releaseFileLock.                        *)
\* releaseFileLock сначала гасит таймер; колбэк сердцебиения синхронный, между его
\* lstat и utimes свой процесс не шагает.
CS(p) ==
  /\ pc[p] = "cs" /\ hb[p] = "idle" /\ Go(p, "r_rmown")
  /\ Keep(p) /\ UNCHANGED local

RRmOwn(p) ==
  /\ pc[p] = "r_rmown"
  /\ RmOwner(p, heldTok[p]) /\ Go(p, "r_rmdir")
  /\ UNCHANGED <<dir, nextGen, alive, crashes, local>>

RRmdir(p) ==
  /\ pc[p] = "r_rmdir"
  /\ Rmdir(p) /\ Go(p, "done")
  /\ UNCHANGED <<nextGen, ents, age, alive, crashes, stolenLive, local>>

\* Сердцебиение активно: асинхронный лок и предохранитель ещё не сработал.
HbOn(p) == Heartbeat /\ held[p] < MaxHold

\* Колбэк созревшего таймера: lstat своего owner-файла по пути. Нет файла или папки
\* (ENOENT) — таймер гаснет: шаг не включён, и время его не ждёт (Lagging).
HbCheck(p) ==
  /\ pc[p] = "cs" /\ hb[p] = "idle" /\ HbOn(p) /\ since[p] >= Period
  /\ dir # 0 /\ heldTok[p] \in ents
  /\ hb' = [hb EXCEPT ![p] = "checked"]
  /\ UNCHANGED <<dir, nextGen, ents, age, pc, alive, local, crashes, stolenLive>>

\* utimes каталога по пути — той папки, что сейчас на пути.
HbTouch(p) ==
  /\ hb[p] = "checked"
  /\ hb' = [hb EXCEPT ![p] = "idle"]
  /\ since' = [since EXCEPT ![p] = 0]
  /\ IF dir # 0 THEN age' = 0 ELSE UNCHANGED age
  /\ UNCHANGED <<dir, nextGen, ents, pc, alive, crashes, stolenLive,
                 tries, tok, mkGen, g1, gfd, cur, stale0, names, toRm, heldTok, heldGen, held>>

----------------------------------------------------------------------------
(* Среда: падение процесса и ход времени.                                  *)
Crash(p) ==
  /\ alive[p] /\ pc[p] \notin {"done", "bounded"} /\ crashes < MaxCrashes
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<dir, nextGen, ents, age, pc, local, stolenLive, hb>>

\* Живой процесс работает с этой папкой синхронно: создал её в текущем заходе, его
\* owner-файл уже в ней (open "wx" путевой) или он её снимает. Синхронный код не
\* отпускает event loop — это короче staleMs (контракт кода).
SyncBusy(q) ==
  /\ alive[q]
  /\ \/ pc[q] \in AStates \cup CStates /\ (mkGen[q] = dir \/ tok[q] \in ents)
     \/ pc[q] \in {"r_rmown", "r_rmdir"} /\ (heldGen[q] = dir \/ heldTok[q] \in ents)

InSection(q) == alive[q] /\ pc[q] = "cs"

\* Допущение MaxLag: колбэк созревшего таймера выполняется не позже чем через MaxLag
\* тиков. Время не уходит дальше, пока просроченный колбэк живого держателя не прошёл.
Lagging(q) ==
  /\ InSection(q) /\ HbOn(q) /\ since[q] >= Period + MaxLag
  /\ \/ hb[q] = "checked"
     \/ dir # 0 /\ heldTok[q] \in ents

Min(a, b) == IF a < b THEN a ELSE b

\* Допущение MaxSection: живой держатель проводит в секции не больше MaxSection тиков.
Tick ==
  /\ dir # 0 /\ age < Stale
  /\ ~\E q \in Procs : SyncBusy(q)
  /\ ~\E q \in Procs : InSection(q) /\ held[q] >= MaxSection
  /\ ~\E q \in Procs : Lagging(q)
  /\ age' = age + 1
  /\ held' = [q \in Procs |-> IF InSection(q) THEN held[q] + 1 ELSE held[q]]
  /\ since' = [q \in Procs |->
                 IF InSection(q) THEN Min(since[q] + 1, Period + MaxLag) ELSE since[q]]
  /\ UNCHANGED <<dir, nextGen, ents, pc, alive, crashes, stolenLive, hb,
                 tries, tok, mkGen, g1, gfd, cur, stale0, names, toRm, heldTok, heldGen>>

\* Работа процесса по коду; сердцебиение — отдельный таймер (Beat): его шаги не
\* заменяют держателю движение к снятию, поэтому fairness стоит на Work.
Work(p) ==
  /\ alive[p]
  /\ \/ Start(p) \/ Timeout(p)
     \/ ALstat(p) \/ AOpen(p) \/ AOwner(p) \/ ACur(p) \/ AOwnStat(p) \/ AReaddir(p)
     \/ CRmOwn(p) \/ CRmdir(p)
     \/ ILstat(p) \/ IOpen(p) \/ IReaddir(p) \/ ICur(p) \/ IRm(p) \/ IRmdir(p)
     \/ CS(p) \/ RRmOwn(p) \/ RRmdir(p)
  /\ UNCHANGED hb

Beat(p) == alive[p] /\ (HbCheck(p) \/ HbTouch(p))

Step(p) == Work(p) \/ Beat(p)

Next == Tick \/ \E p \in Procs : Step(p) \/ Crash(p)

Spec == Init /\ [][Next]_vars
          \* Сильная: шаг держателя выключен, пока идёт колбэк сердцебиения, и включён между
          \* колбэками — снятие, включённое снова и снова, в итоге случается.
          /\ (\A p \in Procs : SF_vars(Work(p)))
          /\ (\A p \in Procs : WF_vars(Beat(p)))
          /\ (\A p \in Procs : WF_vars(alive[p] /\ Timeout(p)))
          /\ WF_vars(Tick)

----------------------------------------------------------------------------
(* Инварианты замка 1–4 перечислены ниже.                               *)
TypeOK ==
  /\ dir \in 0..nextGen /\ ents \subseteq Tokens /\ age \in 0..Stale
  /\ dir = 0 => ents = {}
  /\ since \in [Procs -> 0..(Period + MaxLag)] /\ held \in [Procs -> 0..MaxSection]

\* 1. Не больше одного живого процесса в критической секции.
MutualExclusion ==
  \A a, b \in Procs : (alive[a] /\ alive[b] /\ pc[a] = "cs" /\ pc[b] = "cs") => a = b

\* 1'. Слабая форма из спеки T95: не больше одного держателя, чей owner-файл
\* жив в папке его поколения (кража отнимает файл, но не секцию).
MutualExclusionOwned ==
  \A a, b \in Procs :
    (/\ alive[a] /\ pc[a] = "cs" /\ heldGen[a] = dir /\ heldTok[a] \in ents
     /\ alive[b] /\ pc[b] = "cs" /\ heldGen[b] = dir /\ heldTok[b] \in ents) => a = b

\* 2. Никто, кроме владельца, не удаляет owner-файл живого держателя; rmdir
\* непустой папки невозможен по построению Rmdir.
NoSuccessorRemoval == ~stolenLive

\* 3. Контракт (T95, раунд 2): пустую папку живого претендента может снести
\* параллельная уборка (путевой rmdir нельзя привязать к открытой папке) — претендент
\* это видит (ENOENT или чужая папка) и повторяет; из снесённой папки держатель не
\* получается: живой держатель всегда держит текущую папку со своим owner-файлом.
CrashWindowSafe ==
  \A p \in Procs : (alive[p] /\ pc[p] = "cs") => (heldGen[p] = dir /\ heldTok[p] \in ents)

\* Граница модели MaxTries не достигнута: вызов не «сдался» по границе модели, значит
\* живость ниже доказана без неё. Держится на 2 процессах. На 3 достижима: два живых
\* претендента по очереди сносят пустые папки друг друга путевым rmdir на пути catch
\* (контракт 3); без дедлайна это может длиться, с дедлайном вызов вернёт null.
NoBounded == \A p \in Procs : pc[p] # "bounded"

\* Свидетель: живой держатель просидел в секции не меньше Stale тиков. Обязан
\* НАРУШАТЬСЯ в конфиге с сердцебиением и MaxSection >= Stale (FileLock-witness.cfg):
\* только тогда «медленный держатель не обокраден» — про сердцебиение. Мутант без Beat
\* его не нарушает: охрана ~Lagging останавливает время, и модель вырождается.
NotSlow == \A p \in Procs : ~(InSection(p) /\ held[p] >= Stale)

\* 4a. Каждый вызов с дедлайном завершается: замок или null (или процесс упал).
Termination == <>(\A p \in Procs : pc[p] \in {"done", "bounded"} \/ ~alive[p])

\* 4b. Брошенный замок (все owner-файлы — упавших, и никто живой его не
\* создаёт и не держит) в итоге забирают: кто-то живой входит в секцию (по
\* CrashWindowSafe при Abandoned живых в секции нет, так что это новый захват) —
\* либо ждать некому (все вернули null или упали). Временное ~Abandoned (кто-то
\* создал пустую папку) не считается.
Abandoned ==
  /\ dir # 0
  /\ \A t \in ents : ~alive[Owner(t)]
  /\ ~\E q \in Procs : \/ SyncBusy(q)
                       \/ InSection(q) /\ (heldGen[q] = dir \/ heldTok[q] \in ents)
Waiting == \E p \in Procs : alive[p] /\ pc[p] \notin {"done", "bounded"}
Taken == \E p \in Procs : alive[p] /\ pc[p] = "cs"
EventuallyTaken == (Abandoned /\ Waiting) ~> (Taken \/ ~Waiting)
=============================================================================
