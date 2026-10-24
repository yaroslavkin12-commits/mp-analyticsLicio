# mp-analyticsLicio — выжимка проекта для агента (Codex)

Внутренний сервис аналитики продаж одежды/автотоваров на Ozon для нескольких магазинов
(юрлиц). Владелец — Евгений. Интерфейс и тексты — на русском. Прод: https://mp-analyticslicio-1.onrender.com

## 1. Стек и запуск

- **Backend:** Node.js + Express, `backend/src/index.js`; Postgres (Neon) через `backend/src/db.js` (`query(sql, params)`).
- **Frontend:** React + Vite, `dashboard/` (собирается в `dashboard/dist`, его же раздаёт Express).
- **Хостинг:** Render (`render.yaml`): build `cd backend && npm i && cd ../dashboard && npm i && npm run build`, start `node backend/src/index.js`.
- **Сбор данных Ozon:** Google Apps Script `google-apps-script/ozon-sheet-sync.gs` — пишет данные во вкладки Google-таблицы; backend читает вкладки через gviz CSV (`collectors/ads/sheetSync.js`, `fetchSheetRows(tab, cabinet)`).
- **Важно:** Render **не ходит в API Ozon** (флаг `ADS_DIRECT_DISABLED=true`). Поток данных всегда: Ozon API → Apps Script → Google Sheet → backend → Postgres → UI.

Локально:
```
# Postgres на 5433 (любой), затем:
cd backend && DATABASE_URL=postgres://postgres@localhost:5433/mp PORT=3999 node src/index.js
cd dashboard && npx vite build      # UI отдаётся бэкендом на :3999
```
Таблицы создаются кодом (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` в местах использования + `postgres/`).

## 2. Кабинеты (магазины)

`backend/src/config/cabinets.js`:
- `licio` — свой магазин (одежда). **Licio сейчас не трогаем** (правило владельца).
- `defly` — основной магазин (дефлекторы, чехлы, утеплители, аксессуары для авто).
- Магазины «из таблицы» (family `defly`, `sheetOnly`): `nabauto` (NABauto), `alex`, `fullgas`, `accent` (Accent Line). Подключён, если на Render задан `ADS_SHEET_ID_<ID>`.
- У каждого магазина свой проект Apps Script со своими ключами Ozon в Script Properties. При изменении `.gs` владелец сам вставляет новую версию во все проекты.

## 3. Правила работы (обязательно)

1. **Секреты никогда не просим в чат.** Ключи Ozon — только в Script Properties Apps Script; ключи сервиса — в Render Environment.
2. Изменения **смысла данных** (как считается метрика) — сначала предложить, потом делать. UI/баги — можно сразу.
3. Тексты UI, подсказки и коммиты — по-русски, понятным языком без жаргона.
4. После правок: `npx vite build` в `dashboard`, проверить локально (Playwright/Chromium есть), затем коммит.
5. Не писать инструкции для накрутки отзывов/фиктивных выкупов с готовыми текстами — отказ.
6. После проверок и коммита сразу отправлять изменения в GitHub: владелец разрешил это без отдельного запроса. Пуш в main запускает деплой Render; проверять результат публикации.

## 4. Apps Script (`google-apps-script/ozon-sheet-sync.gs`)

Вкладки (`SHEET_NAMES`): Catalog, Analytics, AnalyticsHistory, Stocks, Campaigns, Stats, CampaignSkus, Orders, SkuStats, CpoProducts, CpcBids, CpoOrders, GeoOrders, StocksWh, Queries, AnalyticsMonthly, Buyout, Prices, Finance.

Точки входа (триггеры через `setupTriggers`): `syncRecent` (часто), `syncDaily`, `syncOrders` (каждые 5 мин, заказы за 2 дня, вкладка хранит 3 дня), `syncFinance*`, `syncMonthly*`, `syncGeo*`, `syncQueries*`, `syncPrices`, `syncStocksWh`, `syncCpoOrders*`, `syncSkuHistory*`.
Разовые/диагностика: `probeOrders`, `probeCampaigns`, `probeOzonApi`, `backfillOrders14d` (перезабрать заказы за 14 дней; 3 часа вкладка Orders держит 15 дней).

Факты API Ozon, на которые опирается код:
- Списки отправлений: **FBO `/v3/posting/fbo/list`**, **FBS `/v4/posting/fbs/list`** (cursor, ответ `{has_next, cursor, postings}`). Старые v2 FBO / v3 FBS отключены с 31.08.2026 (`obsolete method`). Хелперы `eachPostingCursor_`, `eachFboPosting_`, `eachFbsPosting_`.
- В новых методах `products[].price` — **объект** `{amount: "3500", currency: "RUB"}` → `postingPrice_()` (запасной вариант — `financial_data`).
- Каталог `/v3/product/info/list` → `model_info.model_id` (склейка карточек).
- Кампании Performance API: `productAutopilotStrategy`: `TARGET_BIDS` = «Средняя стоимость клика», `TARGET_CIR` = «Целевой расход», **`TOP_MAX_CLICKS` = «Автостратегия»** (сверено с кабинетом), `MAX_CLICKS` = предположительно «Вывод в ТОП» (не подтверждено). `placement`: `PLACEMENT_TOP_PROMOTION` = «Поиск», `PLACEMENT_SEARCH_AND_CATEGORY` = «Поиск и рекомендации». Цель ДРР для ЦР в API **не отдаётся** → вводится вручную в сервисе. Колонка `extra` в Campaigns — все прочие поля кампании (JSON, есть `createdAt`).

## 5. Backend: основные модули

`backend/src/routes/*` (монтируются в `index.js`):
- `ads.js` (`/api/ads` и `/api/promo`) — страница «Реклама»: `/stats` собирает по артикулам дни (аналитика + расходы РК + ручные значения + остатки), кампании с `zone` (search/rec по **placement**, затем по названию), `kind` (Cir/Auto/Top для автостратегий), `targetDrr`, `adDrr`; разбивка расхода/кликов по стратегиям (`spendSearch/Rec/Cir/Auto/Top`, `clicks*`); самовыкупы (`selfQ/selfR/selfFbs`). Также `/events` (журнал), `/campaign-target` (ручная цель ДРР, таблица `ad_campaign_targets`), группы, порядок, «в пути».
- `sales.js` — аналитика продаж (`/data`, `/summary` по магазинам), вычитает самовыкупы из заказов.
- `finance.js` — P&L из начислений Ozon (`/pnl`), самовыкупы без себестоимости.
- `orders.js` — «Лента заказов»: `/feed` (заказы из `order_feed`, категория, цена; если цены нет — оценка из `price_daily` с флагом `est`), `/self` (отметка самовыкупа).
- `pricelog.js` — «Журнал цен»: снимки цен, планы, правила/группы изменений, окна «до/после» (7 дней по день загрузки включительно / 7 полных дней со следующего).
- `clusters.js` — склейки (model_id) и подсказки «забыли склеить».
- `production.js`, `plan.js`, `stocks.js`, `discounts.js`, `queries.js`, `trackedArticles.js` (Telegram-уведомления о заказах), `digest.js`, `settings.js`, `analytics.js`, `dashboard.js`.

`backend/src/collectors/ads/sheetSync.js` — импорт вкладок в БД: каталог (model_id, архив), кампании (привязка к артикулу: сначала товары из статистики/CampaignSkus, иначе артикул целым словом в названии, самый длинный), журнал авто-событий `ad_events` (вкл/выкл РК, **новые РК**, бюджеты, ставки), бэкфилл «РК запущена (новая)».
`backend/src/collectors/trackedOrdersPoll.js` — чтение вкладки Orders → `order_feed` + уведомления (окно 24 ч).
`backend/src/lib/orderFeed.js` — `order_feed`, `self_buyouts`; `selfByDay/selfBySku` (цена самовыкупа = актуальная цена из ленты), `applyToAnalytics`, `matchToSales`.
`backend/src/lib/adZone.js` — `zoneOf`, `strategyOf`, `targetDrrOf`, `campLabel` (подпись РК в журнале).
`backend/src/lib/categories.js` — дерево категорий (авто по названию + ручные переопределения).
`backend/src/lib/dataVersion.js` — `bump()` сбрасывает кэши после изменений данных.

## 6. Frontend (`dashboard/src`)

- `App.jsx` — страницы, переключение по `page`; событие `window` `mp-open {cabinet, page}`. Тяжёлые страницы получают `active`/`armed` (фоновая подгрузка).
- `components/Sidebar.jsx` — меню: Сводка по магазинам, Аналитика продаж, РНП, Лента заказов, План/факт, Средний чек, ABC, Сезонность, География, Реклама, Позиции, Соинвест, Остатки, Производство, % выкупа, Юнит-экономика, Цены и маржа, Журнал цен, P&L, Сверка, Уведомления, Калькулятор, Товары (Себестоимость/Склейки).
- `pages/AdsStats2.jsx` — «Реклама» (самая большая страница):
  - основная таблица `table.a-t.a-main` (компактная, колонка «Работает» = запущенные виды РК: поиск / п+р / ЦР n% / АС / ТОП / ОЗЗ n%, + «РК x/y»);
  - карточка артикула `Detail`: шапка → 6 плиток KPI → воронка ступенями (`FunnelSteps`) + журнал → `DaysTable` («По дням», закреплены «Метрика»/«Итого», строки по стратегиям скрываются если пусто, самовыкупы под «+ сам.») → `DualChart` → кампании (свёрнуты, `CampaignsTable` с вводом цели ДРР для ЦР);
  - модель: `RAW_KEYS`, `dayRaw`, `derive`, `buildModel`, `DAY_ROWS`, `STRAT_PARTS`, `stratOf`.
- `pages/unitModel.js` — единая модель прибыли (`unitCoefs`, `unitProfit`): выкуп, комиссия FBO/FBS, логистика, эквайринг, прочее, налог от доли покупателя, реклама; самовыкуп = комиссия + эквайринг + налог + 20 ₽ сервисный сбор за FBS-отправление (логистики у самовыкупа нет).
- `pages/Rnp.jsx` (РНП), `OrdersFeed.jsx` (лента, фильтры категории/цены, отметка самовыкупов), `ShopsSummary.jsx` (сводка по магазинам Ozon, «Поступление на 1 выкуп»), `TableBuilder.jsx` (конструктор + набор цен, метрики «за год»), `PriceLog.jsx`, `PnL.jsx`, `SalesAnalytics.jsx`, `Margin.jsx`, `Products.jsx`/`Clusters.jsx`/`Costs.jsx`.
- `lib/pnlCalc.js` — итоги P&L как на странице P&L; `lib/stickyHeads.js` — липкие шапки для `table.a-t` (таблицы с классом `no-sh` пропускаются).
- Стили: `pages/ads2.css` (токены `--a-*`, тёмная/светлая тема), `pages/sales.css`. Важно: `.mpui table.a-t` задаёт `min-width:1040px` — переопределять с большей специфичностью.

## 7. Ключевые бизнес-правила

- **Самовыкупы** (отметка в «Ленте заказов»): убираются из заказов/выручки в аналитике, РНП, рекламе (ДРР считается без них), конструкторе; в P&L/марже — выручка остаётся, себестоимость не вычитается; в прогнозе прибыли рекламы — расход = комиссия + эквайринг + налог + 20 ₽/FBS-отправление.
- **ДРР** = расход / сумма заказов; «с выкупом» = расход / (заказы × % выкупа). «ДРР РК» = расход РК / выручка заказов, которые Ozon отнёс к этой РК (с ним сравнивается цель ЦР).
- Оплата за заказ в «Рекламе» стоит в дне заказа (в P&L — в дне списания).
- Сводка по магазинам — **только Ozon** (WB и опт в сервисе пока нет); план/факт там не нужен.
- Журнал цен: «до» = 7 дней по день загрузки включительно, «после» = 7 полных дней со следующего дня.

## 8. Деплой (как делал предыдущий агент)

Пуш в `main` репозитория `github.com/yaroslavkin12-commits/mp-analyticsLicio` → Render деплоит автоматически (~3–5 мин). Сообщение коммита — по-русски, что поменялось для пользователя. Проверка на проде — запросами к `https://mp-analyticslicio-1.onrender.com/api/...` (например `/api/promo/stats?cabinet=defly&dateFrom=…&dateTo=…`, `/api/orders/feed?cabinet=defly`).

## 9. Открытые хвосты

### Общий план Ozon (24.10.2026)

«План / факт» переработан в «Планирование / Выполнение»: единый план пяти магазинов,
редактируемые непересекающиеся подкатегории, автоматические родительские итоги,
предпросмотр распределения, явная фиксация и история. Подробные правила, формулы,
ограничения и проверки: [docs/ozon-plan.md](docs/ozon-plan.md).
Старые планы кабинетов сохраняются в прежних ключах и доступны в архиве страницы.
Новые ключи — plan:ozon:v2:<месяц>. Факт — существующая модель pnlTotals;
отсутствующие финансы не подменять нулями. Licio не включён в общий план.

### Остальные задачи

- Подтвердить, что `MAX_CLICKS` = «Вывод в ТОП» (нужна живая РК с этой стратегией).
- Автостратегия Весты («…V017-2 (АС)», реально товар V017-2K) — перепривяжется, когда скрипт соберёт CampaignSkus/SkuStats по этой РК.
- 5 FBS-заказов «ожидает сборки» без цены от Ozon — проверить, подтянулась ли цена.
- Владельцу: вставить последнюю версию `.gs` во все проекты (NAB/Alex/Fullgas/Accent) и один раз запустить `backfillOrders14d`; в NAB — `syncGeoFull`, `syncAnalyticsHistory`.
