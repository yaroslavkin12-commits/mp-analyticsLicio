const { query } = require('../../db');

// Настройки уведомлений по Соинвесту/СПП — по одному набору на кабинет,
// хранятся в app_settings (ключ-значение, JSON в значении). Аналог вкладки
// "Настройки" в СПП-мониторе TrueStats: порог срабатывания, тихие часы и
// ежедневный дайджест в заданное время.

const DEFAULTS = {
  thresholdPct: 1.5,     // мин. сдвиг в п.п., чтобы прислать уведомление о конкретном изменении
  quietEnabled: false,   // не слать уведомления ночью
  quietStart: '23:00',
  quietEnd: '08:00',
  digestEnabled: false,  // ежедневная сводка топ-изменений одним сообщением
  digestTime: '09:00',
  timezone: 'Europe/Moscow',
};

function keyFor(cabinet) { return `discount_notify_${cabinet}`; }

async function getSettings(cabinet) {
  try {
    const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [keyFor(cabinet)]);
    if (!rows.length) return { ...DEFAULTS };
    const parsed = JSON.parse(rows[0].value);
    return { ...DEFAULTS, ...parsed };
  } catch (e) { return { ...DEFAULTS }; }
}

async function setSettings(cabinet, patch) {
  const current = await getSettings(cabinet);
  const next = { ...current, ...patch };
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [keyFor(cabinet), JSON.stringify(next)]);
  return next;
}

// Сейчас ли "тихие часы" для кабинета (время местное, с учётом timezone).
// Поддерживает интервал через полночь (23:00 -> 08:00).
function isQuietNow(settings, now = new Date()) {
  if (!settings.quietEnabled) return false;
  const dayjs = require('dayjs');
  require('dayjs/plugin/utc'); require('dayjs/plugin/timezone');
  const utc = require('dayjs/plugin/utc'); const tz = require('dayjs/plugin/timezone');
  dayjs.extend(utc); dayjs.extend(tz);
  const local = dayjs(now).tz(settings.timezone || 'Europe/Moscow');
  const mins = local.hour() * 60 + local.minute();
  const [sh, sm] = (settings.quietStart || '23:00').split(':').map(Number);
  const [eh, em] = (settings.quietEnd || '08:00').split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  if (start === end) return false;
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end; // через полночь
}

module.exports = { DEFAULTS, getSettings, setSettings, isQuietNow };
