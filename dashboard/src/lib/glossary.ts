// Glossary: the single source of truth for every abbreviation and weather term the dashboard shows. The <Term>
// component (components/Term.tsx) renders these as tooltips. Explanations are neutral and one line each; they never
// say which model is best. Every model in lib/models.ts must have an entry here under its display name (tested).
export type GlossaryEntry = { full: string; text: string };

export const GLOSSARY = {
  // Models and organizations
  ECMWF: { full: "European Centre for Medium-Range Weather Forecasts", text: "An intergovernmental European weather centre that runs a global forecast model (IFS)." },
  GFS: { full: "Global Forecast System", text: "A global forecast model run by NOAA's National Centers for Environmental Prediction (NCEP)." },
  ICON: { full: "Icosahedral Nonhydrostatic model", text: "A global forecast model run by Germany's national weather service (DWD)." },
  HRRR: { full: "High-Resolution Rapid Refresh", text: "NOAA's short-range, high-resolution model for the contiguous US, updated every hour." },
  NWS: { full: "National Weather Service", text: "The US government's weather agency (part of NOAA); it issues official forecasts and alerts." },
  NOAA: { full: "National Oceanic and Atmospheric Administration", text: "The US federal agency for weather, oceans and climate; it runs the NWS, GFS and HRRR." },
  "Best match": { full: "Open-Meteo best match", text: "Open-Meteo's automatic choice of the best available model for a location." },
  // Forecast accuracy
  MAE: { full: "Mean absolute error", text: "The average size of the forecast errors, ignoring whether they were too warm or too cold." },
  Bias: { full: "Forecast bias", text: "The average of forecast − observed: above 0 the forecasts ran too warm, below 0 too cold." },
  "Lead day": { full: "Lead day (lead time)", text: "How many days before the forecast time the forecast was made; 1 = the day before." },
  Samples: { full: "Sample size", text: "How many forecast–observation pairs the number is based on." },
  Baseline: { full: "Baseline", text: "A simple reference to compare models against; here Open-Meteo's automatic model choice, compared by lead day only." },
  // Forecasts and alerts
  Spread: { full: "Model spread", text: "The range between the lowest and highest model forecast; a wider spread means more uncertainty." },
  "Rain chance": { full: "Probability of precipitation", text: "The chance of measurable rain or snow at that time, in percent." },
  "Forecast period": { full: "NWS forecast period", text: "A 12-hour block (day or night) in the NWS 7-day forecast." },
  Extreme: { full: "Extreme (NWS alert severity)", text: "Extraordinary threat to life or property." },
  Severe: { full: "Severe (NWS alert severity)", text: "Significant threat to life or property." },
  Moderate: { full: "Moderate (NWS alert severity)", text: "Possible threat to life or property." },
  Minor: { full: "Minor (NWS alert severity)", text: "Minimal to no known threat to life or property." },
  // Charts, units and time
  mm: { full: "Millimetres of rain", text: "Rain depth: 1 mm is a 1 mm layer of water on flat ground; 25.4 mm = 1 inch." },
  avg: { full: "Average", text: "The mean of all values in the chart (dashed line)." },
  "Moving average": { full: "Moving average", text: "The average of the last few points (dotted line); it smooths out short ups and downs." },
  KPI: { full: "Key performance indicator", text: "A headline number, like the cards at the top of the page." },
  UTC: { full: "Coordinated Universal Time", text: "The world's reference time; the pipeline stores times in UTC and shows each city's local time." },
  // Forecast replay and data
  "Previous runs": { full: "Open-Meteo Previous Runs", text: "Archived forecasts: what each model predicted 1–7 days before a past date." },
  Observed: { full: "Observed value", text: "What actually happened, from Open-Meteo's historical reanalysis (not a single station)." },
  Reanalysis: { full: "Reanalysis", text: "An estimate of past weather that combines observations with a weather model." },
  "CC BY 4.0": { full: "Creative Commons Attribution 4.0", text: "A licence that allows reuse of the data as long as the source is credited." },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
export const isGlossaryKey = (k: string): k is GlossaryKey => Object.hasOwn(GLOSSARY, k);
