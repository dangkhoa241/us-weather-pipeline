// src/locations/cities.js
// Cities tracked by the pipeline. `npm run seed:locations` loads them into the `locations` collection
// and resolves each one's NWS grid point. The largest city of every state, plus Washington DC, Stockton and Miami (53).

// US Census regions.
const REGIONS = {
  Northeast: ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"],
  Midwest: ["IL", "IN", "MI", "OH", "WI", "IA", "KS", "MN", "MO", "NE", "ND", "SD"],
  South: ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV", "AL", "KY", "MS", "TN", "AR", "LA", "OK", "TX"],
  West: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY", "AK", "CA", "HI", "OR", "WA"],
};

const REGION_BY_STATE = Object.fromEntries(
  Object.entries(REGIONS).flatMap(([region, states]) => states.map((s) => [s, region])),
);

export function regionOf(state) {
  const region = REGION_BY_STATE[state];
  if (!region) throw new Error(`Unknown state code "${state}"`);
  return region;
}

// [name, state, lat, lon, IANA time zone]  (storage stays UTC; the zone is for local-day grouping and display)
const CITY_ROWS = [
  ["New York", "NY", 40.7128, -74.006, "America/New_York"],
  ["Boston", "MA", 42.3601, -71.0589, "America/New_York"],
  ["Philadelphia", "PA", 39.9526, -75.1652, "America/New_York"],
  ["Chicago", "IL", 41.8781, -87.6298, "America/Chicago"],
  ["Detroit", "MI", 42.3314, -83.0458, "America/Detroit"],
  ["Minneapolis", "MN", 44.9778, -93.265, "America/Chicago"],
  ["Kansas City", "MO", 39.0997, -94.5786, "America/Chicago"],
  ["Houston", "TX", 29.7604, -95.3698, "America/Chicago"],
  ["Miami", "FL", 25.7617, -80.1918, "America/New_York"],
  ["Atlanta", "GA", 33.749, -84.388, "America/New_York"],
  ["Nashville", "TN", 36.1627, -86.7816, "America/Chicago"],
  ["New Orleans", "LA", 29.9511, -90.0715, "America/Chicago"],
  ["Denver", "CO", 39.7392, -104.9903, "America/Denver"],
  ["Phoenix", "AZ", 33.4484, -112.074, "America/Phoenix"],
  ["Las Vegas", "NV", 36.1699, -115.1398, "America/Los_Angeles"],
  ["Los Angeles", "CA", 34.0522, -118.2437, "America/Los_Angeles"],
  ["Stockton", "CA", 37.9577, -121.2908, "America/Los_Angeles"],
  ["Seattle", "WA", 47.6062, -122.3321, "America/Los_Angeles"],
  ["Anchorage", "AK", 61.2181, -149.9003, "America/Anchorage"],
  ["Honolulu", "HI", 21.3069, -157.8583, "Pacific/Honolulu"],
  // Largest city of every other state + Washington DC (Miami stays from the first 20; Jacksonville is Florida's largest).
  ["Huntsville", "AL", 34.7304, -86.5861, "America/Chicago"],
  ["Little Rock", "AR", 34.7465, -92.2896, "America/Chicago"],
  ["Bridgeport", "CT", 41.1865, -73.1952, "America/New_York"],
  ["Wilmington", "DE", 39.7391, -75.5398, "America/New_York"],
  ["Washington", "DC", 38.9072, -77.0369, "America/New_York"],
  ["Jacksonville", "FL", 30.3322, -81.6557, "America/New_York"],
  ["Boise", "ID", 43.615, -116.2023, "America/Boise"],
  ["Indianapolis", "IN", 39.7684, -86.1581, "America/Indiana/Indianapolis"],
  ["Des Moines", "IA", 41.5868, -93.625, "America/Chicago"],
  ["Wichita", "KS", 37.6872, -97.3301, "America/Chicago"],
  ["Louisville", "KY", 38.2527, -85.7585, "America/Kentucky/Louisville"],
  ["Portland", "ME", 43.6591, -70.2568, "America/New_York"],
  ["Baltimore", "MD", 39.2904, -76.6122, "America/New_York"],
  ["Jackson", "MS", 32.2988, -90.1848, "America/Chicago"],
  ["Billings", "MT", 45.7833, -108.5007, "America/Denver"],
  ["Omaha", "NE", 41.2565, -95.9345, "America/Chicago"],
  ["Manchester", "NH", 42.9956, -71.4548, "America/New_York"],
  ["Newark", "NJ", 40.7357, -74.1724, "America/New_York"],
  ["Albuquerque", "NM", 35.0844, -106.6504, "America/Denver"],
  ["Charlotte", "NC", 35.2271, -80.8431, "America/New_York"],
  ["Fargo", "ND", 46.8772, -96.7898, "America/Chicago"],
  ["Columbus", "OH", 39.9612, -82.9988, "America/New_York"],
  ["Oklahoma City", "OK", 35.4676, -97.5164, "America/Chicago"],
  ["Portland", "OR", 45.5152, -122.6784, "America/Los_Angeles"],
  ["Providence", "RI", 41.824, -71.4128, "America/New_York"],
  ["Charleston", "SC", 32.7765, -79.9311, "America/New_York"],
  ["Sioux Falls", "SD", 43.5446, -96.7311, "America/Chicago"],
  ["Salt Lake City", "UT", 40.7608, -111.891, "America/Denver"],
  ["Burlington", "VT", 44.4759, -73.2121, "America/New_York"],
  ["Virginia Beach", "VA", 36.8529, -75.978, "America/New_York"],
  ["Charleston", "WV", 38.3498, -81.6326, "America/New_York"],
  ["Milwaukee", "WI", 43.0389, -87.9065, "America/Chicago"],
  ["Cheyenne", "WY", 41.14, -104.8202, "America/Denver"],
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Throws on a zone name the runtime does not know (catches typos at startup). */
function checkTimeZone(timeZone) {
  new Intl.DateTimeFormat("en-US", { timeZone });
  return timeZone;
}

export const CITIES = CITY_ROWS.map(([name, state, lat, lon, timeZone]) => ({
  id: `${slug(name)}-${state.toLowerCase()}`,
  name,
  state,
  region: regionOf(state),
  lat,
  lon,
  timezone: checkTimeZone(timeZone),
}));
