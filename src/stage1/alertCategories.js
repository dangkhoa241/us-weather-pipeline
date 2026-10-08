// src/stage1/alertCategories.js
// NWS event name → alert category for the public email sign-ups (docs/analysis/email-signups.md, section 2).
// Exact names only, so the mapping is reviewable and testable. Anything else is "other": stored and shown on the
// dashboard, never emailed. Pure module: shared by the collector, the sign-up Lambda and the dashboard.

export const CATEGORY_EVENTS = Object.freeze({
  heat: ["Extreme Heat Warning", "Extreme Heat Watch", "Excessive Heat Warning", "Excessive Heat Watch", "Heat Advisory"],
  flood: [
    "Flood Warning", "Flood Watch", "Flood Advisory", "Flood Statement",
    "Flash Flood Warning", "Flash Flood Watch", "Flash Flood Statement",
    "Coastal Flood Warning", "Coastal Flood Watch", "Coastal Flood Advisory", "Coastal Flood Statement",
    "Lakeshore Flood Warning", "Lakeshore Flood Watch", "Lakeshore Flood Advisory", "Lakeshore Flood Statement",
    "Hydrologic Advisory",
  ],
  wind_storm: [
    "Tornado Warning", "Tornado Watch", "Severe Thunderstorm Warning", "Severe Thunderstorm Watch", "Severe Weather Statement",
    "Extreme Wind Warning", "High Wind Warning", "High Wind Watch", "Wind Advisory", "Lake Wind Advisory",
    "Dust Storm Warning", "Dust Advisory", "Blowing Dust Warning", "Blowing Dust Advisory",
  ],
  winter: [
    "Winter Storm Warning", "Winter Storm Watch", "Winter Weather Advisory", "Blizzard Warning", "Ice Storm Warning",
    "Lake Effect Snow Warning", "Lake Effect Snow Watch", "Snow Squall Warning",
    "Freeze Warning", "Freeze Watch", "Hard Freeze Warning", "Hard Freeze Watch", "Frost Advisory",
    "Cold Weather Advisory", "Extreme Cold Warning", "Extreme Cold Watch", "Freezing Fog Advisory",
  ],
  fire_air: [
    "Red Flag Warning", "Fire Weather Watch", "Fire Warning", "Extreme Fire Danger",
    "Air Quality Alert", "Air Stagnation Advisory", "Dense Smoke Advisory", "Ashfall Warning", "Ashfall Advisory",
  ],
  tropical: [
    "Hurricane Warning", "Hurricane Watch", "Tropical Storm Warning", "Tropical Storm Watch",
    "Storm Surge Warning", "Storm Surge Watch", "Typhoon Warning", "Typhoon Watch", "Tropical Cyclone Local Statement",
  ],
});

/** Shown on the sign-up form and at the top and bottom of every subscriber email. */
export const DISCLAIMER = "Not an official warning service. For emergencies, use weather.gov and your phone's emergency alerts.";

/** Categories a visitor can choose (sign-up allowlist). `test` is owner-only and never offered. */
export const PUBLIC_CATEGORIES = Object.freeze(Object.keys(CATEGORY_EVENTS));
/** Owner-only category for end-to-end tests: no public subscription can contain it. */
export const TEST_CATEGORY = "test";

export const CATEGORY_LABELS = Object.freeze({
  heat: "Heat", flood: "Flood", wind_storm: "Wind & storm", winter: "Winter",
  fire_air: "Fire & air quality", tropical: "Tropical", test: "Test",
});

// Known NWS events that are deliberately not emailed (beach, marine, fog, catch-all statements, non-weather, civil
// emergencies). Listed so that only truly unknown names are logged as "unmapped".
export const OTHER_EVENTS = Object.freeze([
  "Rip Current Statement", "Beach Hazards Statement", "High Surf Advisory", "High Surf Warning",
  "Small Craft Advisory", "Gale Warning", "Gale Watch", "Storm Warning", "Storm Watch", "Hurricane Force Wind Warning",
  "Hurricane Force Wind Watch", "Hazardous Seas Warning", "Hazardous Seas Watch", "Special Marine Warning",
  "Marine Weather Statement", "Brisk Wind Advisory", "Heavy Freezing Spray Warning", "Heavy Freezing Spray Watch",
  "Freezing Spray Advisory", "Low Water Advisory", "Dense Fog Advisory", "Special Weather Statement",
  "Hazardous Weather Outlook", "Hydrologic Outlook", "Short Term Forecast", "Test Message", "Administrative Message",
  "Tsunami Warning", "Tsunami Watch", "Tsunami Advisory", "Earthquake Warning", "Avalanche Warning", "Avalanche Watch",
  "Avalanche Advisory", "Volcano Warning", "Child Abduction Emergency", "Civil Danger Warning", "Civil Emergency Message",
  "Evacuation Immediate", "Shelter In Place Warning", "Law Enforcement Warning", "Hazardous Materials Warning",
  "Nuclear Power Plant Warning", "Radiological Hazard Warning", "911 Telephone Outage", "Local Area Emergency", "Blue Alert",
]);

const BY_EVENT = new Map(Object.entries(CATEGORY_EVENTS).flatMap(([cat, events]) => events.map((e) => [e, cat])));
const OTHER = new Set(OTHER_EVENTS);

/** "heat" | "flood" | … for an emailable NWS event, otherwise null ("other"). */
export const categoryOf = (event) => BY_EVENT.get(event) ?? null;

/** True for an event name that is neither mapped nor known as "other" (logged so the mapping can be extended). */
export const isUnmappedEvent = (event) => !BY_EVENT.has(event) && !OTHER.has(event);
