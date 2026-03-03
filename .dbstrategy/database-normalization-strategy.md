# Database Normalization Strategy

## Scope
This document proposes a normalization strategy for the `dashboard_producao` MariaDB schema without applying changes yet.

## Current Structure Summary
- `production_history(date_key, item_key, target, done, rejected, updated_at)`
- `production_audit_log(id, event_type, item_key, source_ip, user_agent, payload_json, created_at)`
- `production_app_state(state_key, state_json, updated_at)`

## Key Normalization Gaps
1. `production_app_state.state_json` stores large nested object graphs (`daily_progress`, `final_products_history`) instead of atomic relational rows.
2. `production_history.date_key` is stored as `varchar(10)` instead of native `DATE`.
3. `item_key` is repeated text across tables with no shared dimension table and no foreign keys.
4. `production_audit_log.payload_json` duplicates values that also exist in relational columns.
5. Quantity fields (`target`, `done`, `rejected`) are `double`; these are count-like values and should be integer/decimal types depending on business rules.

## Target Normalized Model
### 1) `items`
- `item_id` (PK, surrogate)
- `item_key` (UNIQUE)
- Optional parsed business fields: `sigla`, `codigo`

### 2) `production_daily`
- `production_daily_id` (PK)
- `production_date` (`DATE`, indexed)
- `item_id` (FK -> `items.item_id`)
- `target_qty`, `done_qty`, `rejected_qty`
- `updated_at`
- UNIQUE (`production_date`, `item_id`)

### 3) `production_rejections`
- `rejection_id` (PK)
- `production_daily_id` (FK -> `production_daily.production_daily_id`)
- `category`, `reason`, `observation`
- `rejected_count`

### 4) `production_events` (optional normalized event projection)
- Keep existing `production_audit_log` as immutable audit source
- Optionally add typed projection table for frequent queries:
  - `event_id` (PK/FK to audit id)
  - `event_type`
  - `item_id` (nullable FK)
  - `event_at`

### 5) `production_app_state`
- Keep as cache/snapshot only
- Do not treat as source of truth

## Migration Strategy (No Downtime)
1. **Add new tables**
- Create `items`, `production_daily`, `production_rejections`.
- Add indexes and foreign keys.

2. **Backfill phase**
- Populate `items` from distinct `item_key` values.
- Backfill `production_daily` from `production_history`.
- Expand rejection entries from JSON source where available.

3. **Dual-write phase**
- Update application to write both legacy and normalized tables.
- Add consistency checks in jobs/scripts.

4. **Read switch phase**
- Move read paths/reports to normalized tables.
- Keep fallback reads to legacy for a short validation window.

5. **Deprecation phase**
- Stop legacy writes.
- Freeze legacy tables (`production_history`, JSON state payload usage) and archive as needed.

## Data Quality and Constraints Recommendations
- Convert `date_key` to `DATE` in new model.
- Use `INT`/`BIGINT` for count fields, or `DECIMAL` if fractional values are valid by business rule.
- Enforce non-negative checks where possible.
- Add FK constraints for all item references.
- Add unique constraints to prevent duplicate daily rows.

## Risks
- Existing code likely depends on JSON snapshots for UI state.
- Event payload schemas in `payload_json` may vary by `event_type`.
- Legacy row keys (`item_key`) may require standardization before strict FK enforcement.

## Success Criteria
- No data loss during migration.
- Reports for daily production/rejections served from normalized tables.
- Referential integrity enforced by foreign keys.
- Audit logging preserved with queryable relational projections.
