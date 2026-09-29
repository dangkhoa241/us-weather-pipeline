// src/locations/cities.js
// Cities tracked by the pipeline. `npm run seed:locations` loads them into the `locations` collection
// and resolves each one's NWS grid point. Test set of 20 for now; to be expanded to ~150.

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

// [name, state, lat, lon]
const CITY_ROWS = [
  ["New York", "NY", 40.7128, -74.006],
  ["Boston", "MA", 42.3601, -71.0589],
  ["Philadelphia", "PA", 39.9526, -75.1652],
  ["Chicago", "IL", 41.8781, -87.6298],
  ["Detroit", "MI", 42.3314, -83.0458],
  ["Minneapolis", "MN", 44.9778, -93.265],
  ["Kansas City", "MO", 39.0997, -94.5786],
  ["Houston", "TX", 29.7604, -95.3698],
  ["Miami", "FL", 25.7617, -80.1918],
  ["Atlanta", "GA", 33.749, -84.388],
  ["Nashville", "TN", 36.1627, -86.7816],
  ["New Orleans", "LA", 29.9511, -90.0715],
  ["Denver", "CO", 39.7392, -104.9903],
  ["Phoenix", "AZ", 33.4484, -112.074],
  ["Las Vegas", "NV", 36.1699, -115.1398],
  ["Los Angeles", "CA", 34.0522, -118.2437],
  ["Stockton", "CA", 37.9577, -121.2908],
  ["Seattle", "WA", 47.6062, -122.3321],
  ["Anchorage", "AK", 61.2181, -149.9003],
  ["Honolulu", "HI", 21.3069, -157.8583],
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const CITIES = CITY_ROWS.map(([name, state, lat, lon]) => ({
  id: `${slug(name)}-${state.toLowerCase()}`,
  name,
  state,
  region: regionOf(state),
  lat,
  lon,
}));
