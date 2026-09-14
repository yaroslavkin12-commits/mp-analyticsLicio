const { query } = require('../../db');

// Статус фонового сбора рекламной аналитики по кабинету — общий для ручного
// запуска (routes/ads.js POST /collect) и автоматического (scheduler.js
// runAdsCabinets), которые раньше могли запускаться ОДНОВРЕМЕННО для одного
// и того же кабинета: scheduler.js гоняет полный сбор при каждом старте
// процесса и затем каждые COLLECT_INTERVAL_HOURS, а /collect можно дёрнуть
// вручную в любой момент. Два параллельных сбора одновременно долбят одни и
// те же эндпоинты Ozon, вдвое усиливая лимит запросов — именно это, скорее
// всего, и не давало сбору показов/заказов когда-либо реально завершиться.
// Пишем статус в БД (не в память процесса), чтобы он переживал рестарт
// сервера (Render на бесплатном тарифе засыпает и перезапускается) и чтобы
// оба места запуска могли договориться через один и тот же источник правды.

async function saveRunStatus(cabinet, patch) {
  try {
    await query(
      `INSERT INTO ad_collect_runs (cabinet, started_at, step, detail, error, finished_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (cabinet) DO UPDATE SET
         started_at = COALESCE(EXCLUDED.started_at, ad_collect_runs.started_at),
         step = COALESCE(EXCLUDED.step, ad_collect_runs.step),
         detail = EXCLUDED.detail,
         error = EXCLUDED.error,
         finished_at = EXCLUDED.finished_at,
         updated_at = NOW()`,
      [cabinet, patch.startedAt || null, patch.step || null, patch.detail || null,
       patch.error || null, patch.finishedAt || null]
    );
  } catch(e) { console.warn('[Ads] Не удалось сохранить статус сбора:', e.message); }
}

// Сбор считается всё ещё идущим, если последний известный шаг — не 'done',
// ошибки нет, и статус обновлялся недавно (< STALE_MINUTES назад). Если
// обновлений давно не было — считаем сбор мёртвым (процесс упал без записи
// ошибки) и разрешаем запустить новый, а не блокируем кабинет навсегда.
//
// ВАЖНО: изначально стояло 50 минут — и это тут же выстрелило само в себя.
// Деплой этого же исправления перезапускает сервер, а перезапуск обрывает
// как раз ту работу, которую блокировка должна была защищать: старая запись
// в ad_collect_runs осталась с недавним updated_at (процесс же ещё писал
// прогресс прямо перед тем, как его убили), и после рестарта блокировка
// решила, что сбор "ещё идёт", хотя процесс, который его вёл, уже мёртв —
// и не давала запустить новый почти час. Шаги сбора (каталог/кампании/каждая
// метрика аналитики) обновляют статус каждые несколько минут максимум, так
// что 10 минут без единого обновления — уже достаточный признак мёртвого
// процесса, а не просто долгой обработки.
const STALE_MINUTES = 10;

async function isRunActive(cabinet) {
  try {
    const rows = await query(
      `SELECT step, error, updated_at FROM ad_collect_runs
       WHERE cabinet = $1 AND step IS NOT NULL AND step != 'done' AND error IS NULL
         AND updated_at > NOW() - INTERVAL '${STALE_MINUTES} minutes'`,
      [cabinet]
    );
    return rows.length > 0;
  } catch(e) { return false; }
}

module.exports = { saveRunStatus, isRunActive };
