// Тест не наследует настройку Anthropic с машины разработчика: хост с ANTHROPIC_BASE_URL или
// ключом (так запускают из агентной сессии) валил бы проверки Claude отказом без дефекта в коде.
// Импортировать первой строкой теста, который гоняет путь Claude.
for (const key of Object.keys(process.env))
  if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/u.test(key)) delete process.env[key];
