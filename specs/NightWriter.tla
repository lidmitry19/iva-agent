---- MODULE NightWriter ----
\* Писатель ночи (ADR-0016, Дополнение 2 п.4): ответ модели сохраняется в кэш дня до
\* записи; запись — замена раздела целиком, если хеш файла равен хешу при чтении для
\* вызова; иначе ничего не пишется, ответ стирается из кэша, Card получает truth_pending
\* и вызов повторяется следующей ночью. Каждая запись атомарна и коммитится; день готов
\* только после коммита. Обрыв (kill -9) возможен на любом шаге применения.
EXTENDS Naturals

CONSTANT MaxDays

VARIABLES phase, file, answer, committed, calls, lost, queue, human, pending, crashedOnce

vars == <<phase, file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>

Init ==
  /\ phase = "idle"
  /\ file = "old"
  /\ answer = FALSE
  /\ committed = FALSE
  /\ calls = 0
  /\ lost = 0
  /\ queue = MaxDays
  /\ human = FALSE
  /\ pending = FALSE
  /\ crashedOnce = FALSE

Keep(v) == UNCHANGED v

\* Платный вызов модели: только когда ответа в кэше нет.
Call ==
  /\ phase = "idle" /\ queue > 0 /\ ~answer
  /\ phase' = "called" /\ calls' = calls + 1
  /\ Keep(<<file, answer, committed, lost, queue, human, pending, crashedOnce>>)

SaveAnswer ==
  /\ phase = "called"
  /\ phase' = "cached" /\ answer' = TRUE
  /\ Keep(<<file, committed, calls, lost, queue, human, pending, crashedOnce>>)

\* Владелец правит Card, пока ночь ждёт ответа или держит его в кэше.
HumanEdit ==
  /\ phase \in {"called", "cached"} /\ file = "old"
  /\ file' = "human" /\ human' = TRUE
  /\ Keep(<<phase, answer, committed, calls, lost, queue, pending, crashedOnce>>)

\* Хеш совпал: раздел заменён целиком, атомарная запись.
Replace ==
  /\ phase = "cached" /\ file = "old"
  /\ phase' = "written" /\ file' = "new"
  /\ Keep(<<answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

\* Хеш не совпал: запись не идёт, сам ответ стёрт, но кэш помнит, что Card в этом
\* проходе решена (done); Card получает truth_pending, вызов — следующей ночью.
Conflict ==
  /\ phase = "cached" /\ file = "human"
  /\ phase' = "written" /\ pending' = TRUE
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, crashedOnce>>)

\* Повтор после обрыва: файл уже новый (хеш post) — применять нечего.
Resume ==
  /\ phase = "cached" /\ file = "new"
  /\ phase' = "written"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

Commit ==
  /\ phase = "written"
  /\ phase' = "committed" /\ committed' = TRUE
  /\ Keep(<<file, answer, calls, lost, queue, human, pending, crashedOnce>>)

Ready ==
  /\ phase = "committed"
  /\ phase' = "done"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

NextDay ==
  /\ phase = "done"
  /\ phase' = "idle" /\ file' = "old" /\ answer' = FALSE /\ committed' = FALSE
  /\ calls' = 0 /\ lost' = 0 /\ queue' = queue - 1 /\ human' = FALSE /\ pending' = FALSE
  /\ Keep(crashedOnce)

\* kill -9 на любом шаге до готовности.
Crash ==
  /\ ~crashedOnce /\ phase \in {"called", "cached", "written", "committed"}
  /\ phase' = "crashed" /\ crashedOnce' = TRUE
  /\ lost' = IF phase = "called" THEN 1 ELSE lost
  /\ Keep(<<file, answer, committed, calls, queue, human, pending>>)

\* Перезапуск: незакоммиченное коммитится первым делом; ответ из кэша не зовёт модель.
Restart ==
  /\ phase = "crashed"
  /\ phase' = IF file = "new" /\ ~committed THEN "written"
              ELSE IF answer THEN "cached" ELSE "idle"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

Done == queue = 0 /\ UNCHANGED vars

Next ==
  \/ Call \/ SaveAnswer \/ HumanEdit \/ Replace \/ Conflict \/ Resume
  \/ Commit \/ Ready \/ NextDay \/ Crash \/ Restart \/ Done

Spec == Init /\ [][Next]_vars
  /\ WF_vars(Call) /\ WF_vars(SaveAnswer) /\ WF_vars(Replace) /\ WF_vars(Conflict)
  /\ WF_vars(Resume) /\ WF_vars(Commit) /\ WF_vars(Ready) /\ WF_vars(NextDay)
  /\ WF_vars(Restart)

TypeOK ==
  /\ phase \in {"idle", "called", "cached", "written", "committed", "done", "crashed"}
  /\ file \in {"old", "new", "human"}
  /\ answer \in BOOLEAN /\ committed \in BOOLEAN /\ human \in BOOLEAN
  /\ pending \in BOOLEAN /\ crashedOnce \in BOOLEAN
  /\ calls \in 0..2 /\ lost \in 0..1 /\ queue \in 0..MaxDays

\* (1) Файл не бывает частичным: старый, новый или правка человека.
FileNeverPartial == file \in {"old", "new", "human"}
\* Готовность дня — только после коммита.
ReadyOnlyAfterCommit == phase = "done" => committed
\* (3) Правка человека не перетирается.
HumanEditWins == human => file = "human"
\* (2), (4) Повтор ночи не зовёт модель второй раз: лишний вызов — только если обрыв
\* случился во время самого вызова, до сохранения ответа.
NoSecondCall == calls <= 1 + lost
\* Живость: без падений очередь дней доходит до пустой.
QueueDrains == <>(queue = 0)

====
