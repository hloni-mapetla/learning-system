-- Schema v7: momentum, phase 4. The daily minimum, frozen per day, and when the day was rated.
-- Additive only: new nullable columns on days.

-- Whether the day met the daily minimum, frozen with the rule in force (so changing the rule doesn't rewrite the chain).
-- NULL = not frozen: worked out from the day's sessions and steps with the current rule.
ALTER TABLE days ADD COLUMN minimum_met INTEGER CHECK (minimum_met IS NULL OR minimum_met IN (0, 1));
ALTER TABLE days ADD COLUMN minimum_rule TEXT;
ALTER TABLE days ADD COLUMN rated_at TEXT;
