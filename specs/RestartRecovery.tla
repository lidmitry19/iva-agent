---- MODULE RestartRecovery ----
\* Перезапуск Ивы посреди хода (0.4.10). До старта сервиса ExecStartPre смотрит run-status:
\* есть оборванный ход — хранилище workflow уходит в карантин (замок входящих сессии исчезает
\* вместе с ним), запись хода помечается (updatedAt = 0), Bridge закрывает её одной строкой
\* владельцу. Очередь Telegram живёт отдельно и переживает перезапуск. Процесс может упасть на
\* любом шаге, в том числе посреди восстановления; само восстановление может отказать (нет
\* прав, диск) на любом из двух шагов. Карантинов хранится Keep, старые вытесняются.
\*
\* Fixed = FALSE — поведение кандидата 19fd4bea: помеченный ход снова считается оборванным,
\* отказ восстановления не даёт сервису стартовать. Fixed = TRUE — поведение после ремонта.
EXTENDS Naturals

CONSTANTS MaxMsgs, MaxCrashes, MaxFaults, Keep, Fixed

VARIABLES proc, turn, lock, status, queue, sent, answered, noticed,
          crashes, faults, interrupted, quarantines, origKept, blocked

vars == <<proc, turn, lock, status, queue, sent, answered, noticed,
          crashes, faults, interrupted, quarantines, origKept, blocked>>

Init ==
  /\ proc = "up" /\ turn = FALSE /\ lock = FALSE /\ status = "none"
  /\ queue = 0 /\ sent = 0 /\ answered = 0 /\ noticed = 0
  /\ crashes = 0 /\ faults = 0 /\ interrupted = 0
  /\ quarantines = 0 /\ origKept = TRUE /\ blocked = FALSE

Send ==
  /\ sent < MaxMsgs
  /\ sent' = sent + 1 /\ queue' = queue + 1
  /\ UNCHANGED <<proc, turn, lock, status, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* Ход берёт сообщение: живой процесс, свободный замок, прошлый ход закрыт.
StartTurn ==
  /\ proc = "up" /\ ~turn /\ ~lock /\ queue > 0 /\ status = "none"
  /\ turn' = TRUE /\ lock' = TRUE /\ status' = "running" /\ queue' = queue - 1
  /\ UNCHANGED <<proc, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

FinishTurn ==
  /\ proc = "up" /\ turn
  /\ turn' = FALSE /\ lock' = FALSE /\ status' = "none" /\ answered' = answered + 1
  /\ UNCHANGED <<proc, queue, sent, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* kill или restart: ход пропадает, замок и запись остаются на диске.
Crash ==
  /\ proc \in {"up", "recovering"} /\ crashes < MaxCrashes
  /\ proc' = "down" /\ turn' = FALSE /\ crashes' = crashes + 1
  /\ interrupted' = IF turn THEN interrupted + 1 ELSE interrupted
  /\ UNCHANGED <<lock, status, queue, sent, answered, noticed, faults,
                 quarantines, origKept, blocked>>

Boot ==
  /\ proc = "down"
  /\ proc' = "recovering"
  /\ UNCHANGED <<turn, lock, status, queue, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* Что восстановление считает оборванным ходом.
Counts == IF Fixed THEN status = "running" ELSE status \in {"running", "stale"}

\* Шаг 1: карантин хранилища. Снимает замок; лишний карантин вытесняет старые.
Quarantine ==
  /\ proc = "recovering" /\ Counts /\ (lock \/ ~Fixed) /\ quarantines < MaxCrashes + 1
  /\ lock' = FALSE /\ quarantines' = quarantines + 1
  /\ origKept' = (origKept /\ quarantines' - interrupted < Keep)
  /\ UNCHANGED <<proc, turn, status, queue, sent, answered, noticed, crashes, faults,
                 interrupted, blocked>>

\* Шаг 2: запись хода помечается.
MarkStale ==
  /\ proc = "recovering" /\ status = "running" /\ ~lock
  /\ status' = "stale"
  /\ UNCHANGED <<proc, turn, lock, queue, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* Отказ восстановления на любом шаге (нет прав, диск).
Fault ==
  /\ proc = "recovering" /\ faults < MaxFaults /\ status = "running"
  /\ faults' = faults + 1
  /\ IF Fixed
       THEN /\ proc' = "up" /\ blocked' = blocked
       ELSE /\ proc' = "down" /\ blocked' = TRUE
  /\ UNCHANGED <<turn, lock, status, queue, sent, answered, noticed, crashes,
                 interrupted, quarantines, origKept>>

Start ==
  /\ proc = "recovering" /\ status # "running"
  /\ proc' = "up" /\ blocked' = FALSE
  /\ UNCHANGED <<turn, lock, status, queue, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept>>

\* Bridge закрывает оборванный ход одной строкой владельцу. Запись running без хода у живого
\* процесса (восстановление отказало) Bridge закрывает так же, когда она устареет.
Notice ==
  /\ proc = "up" /\ ~turn /\ status \in {"stale", "running"}
  /\ status' = "none" /\ noticed' = noticed + 1 /\ lock' = FALSE
  /\ UNCHANGED <<proc, turn, queue, sent, answered, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

Next ==
  \/ Send \/ StartTurn \/ FinishTurn \/ Crash \/ Boot
  \/ Quarantine \/ MarkStale \/ Fault \/ Start \/ Notice

Fair ==
  /\ WF_vars(StartTurn) /\ WF_vars(FinishTurn) /\ WF_vars(Boot)
  /\ WF_vars(Quarantine) /\ WF_vars(MarkStale) /\ WF_vars(Start) /\ WF_vars(Notice)

Spec == Init /\ [][Next]_vars /\ Fair

TypeOK ==
  /\ proc \in {"up", "down", "recovering"}
  /\ turn \in BOOLEAN /\ lock \in BOOLEAN /\ origKept \in BOOLEAN /\ blocked \in BOOLEAN
  /\ status \in {"none", "running", "stale"}
  /\ queue \in 0..MaxMsgs /\ sent \in 0..MaxMsgs
  /\ answered \in 0..MaxMsgs /\ noticed \in 0..MaxMsgs
  /\ crashes \in 0..MaxCrashes /\ faults \in 0..MaxFaults
  /\ interrupted \in 0..MaxCrashes /\ quarantines \in 0..(MaxCrashes + 1)

\* Сообщение не теряется.
NothingLost ==
  sent = queue + answered + noticed + (IF status \in {"running", "stale"} THEN 1 ELSE 0)

\* Об одном оборванном ходе владелец узнаёт не больше одного раза.
NoticeBounded == noticed <= interrupted

\* Карантин — один на оборванный ход: повторный старт хранилище не трогает.
OneQuarantinePerTurn == quarantines <= interrupted

\* Карантин оборванного хода не вытесняется лишними карантинами.
OriginalKept == origKept

\* Отказ восстановления не оставляет сервис лежать.
NeverBlocked == ~blocked

\* Очередь доигрывается.
QueueDrains == <>[](queue = 0 /\ ~turn /\ status = "none")
====
