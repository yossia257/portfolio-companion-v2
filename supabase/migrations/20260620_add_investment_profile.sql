-- Add Investment Profile fields to profiles table
ALTER TABLE profiles
ADD COLUMN investment_horizon text DEFAULT NULL,
ADD COLUMN risk_tolerance text DEFAULT NULL,
ADD COLUMN portfolio_style text DEFAULT NULL,
ADD COLUMN themes_interest text DEFAULT NULL,
ADD COLUMN themes_avoid text DEFAULT NULL,
ADD COLUMN tax_sensitivity text DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN profiles.investment_horizon IS 'Investment horizon: short, medium_short, medium, long, mixed';
COMMENT ON COLUMN profiles.risk_tolerance IS 'Risk tolerance: low, medium, high';
COMMENT ON COLUMN profiles.portfolio_style IS 'Portfolio style: focused, diversified_sector, diversified_global, opportunistic';
COMMENT ON COLUMN profiles.themes_interest IS 'Investment themes of interest (up to 500 chars)';
COMMENT ON COLUMN profiles.themes_avoid IS 'Investment themes to avoid (up to 500 chars)';
COMMENT ON COLUMN profiles.tax_sensitivity IS 'Tax sensitivity: tax_aware, neutral';
