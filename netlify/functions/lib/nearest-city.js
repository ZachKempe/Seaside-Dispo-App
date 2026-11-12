// "How far is this from a real city?" — shown on a deal that doesn't cash flow,
// where location is the other half of the pitch (cash back at close + you're
// X miles from <city>).
//
// Coordinates come from Google (GOOGLE_MAPS_API_KEY, the key deck-photo.js
// already uses): the Geocoding API first, then the Street View metadata
// endpoint, which carries a lat/lng too and is already enabled wherever the
// deck's auto photos work. The city list is bundled (CITIES below) so there is
// no third API and nothing to configure. Distance is straight-line, and the
// copy says so ("~N mi"), because that is what it is.
//
// Everything fails soft to null: no key, no match, a Google error → the
// caller simply omits the location tile. Results are cached per warm lambda.

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// [name, state, lat, lng] — larger US cities / metro anchors (≈ 100k+ people).
const CITIES = [
  ["New York","NY",40.7128,-74.006],["Los Angeles","CA",34.0522,-118.2437],["Chicago","IL",41.8781,-87.6298],
  ["Houston","TX",29.7604,-95.3698],["Phoenix","AZ",33.4484,-112.074],["Philadelphia","PA",39.9526,-75.1652],
  ["San Antonio","TX",29.4241,-98.4936],["San Diego","CA",32.7157,-117.1611],["Dallas","TX",32.7767,-96.797],
  ["San Jose","CA",37.3382,-121.8863],["Austin","TX",30.2672,-97.7431],["Jacksonville","FL",30.3322,-81.6557],
  ["Fort Worth","TX",32.7555,-97.3308],["Columbus","OH",39.9612,-82.9988],["Charlotte","NC",35.2271,-80.8431],
  ["San Francisco","CA",37.7749,-122.4194],["Indianapolis","IN",39.7684,-86.1581],["Seattle","WA",47.6062,-122.3321],
  ["Denver","CO",39.7392,-104.9903],["Washington","DC",38.9072,-77.0369],["Boston","MA",42.3601,-71.0589],
  ["El Paso","TX",31.7619,-106.485],["Nashville","TN",36.1627,-86.7816],["Detroit","MI",42.3314,-83.0458],
  ["Oklahoma City","OK",35.4676,-97.5164],["Portland","OR",45.5152,-122.6784],["Las Vegas","NV",36.1699,-115.1398],
  ["Memphis","TN",35.1495,-90.049],["Louisville","KY",38.2527,-85.7585],["Baltimore","MD",39.2904,-76.6122],
  ["Milwaukee","WI",43.0389,-87.9065],["Albuquerque","NM",35.0844,-106.6504],["Tucson","AZ",32.2226,-110.9747],
  ["Fresno","CA",36.7378,-119.7871],["Sacramento","CA",38.5816,-121.4944],["Kansas City","MO",39.0997,-94.5786],
  ["Mesa","AZ",33.4152,-111.8315],["Atlanta","GA",33.749,-84.388],["Omaha","NE",41.2565,-95.9345],
  ["Colorado Springs","CO",38.8339,-104.8214],["Raleigh","NC",35.7796,-78.6382],["Miami","FL",25.7617,-80.1918],
  ["Virginia Beach","VA",36.8529,-75.978],["Oakland","CA",37.8044,-122.2712],["Minneapolis","MN",44.9778,-93.265],
  ["Tulsa","OK",36.154,-95.9928],["Tampa","FL",27.9506,-82.4572],["Arlington","TX",32.7357,-97.1081],
  ["New Orleans","LA",29.9511,-90.0715],["Wichita","KS",37.6872,-97.3301],["Cleveland","OH",41.4993,-81.6944],
  ["Bakersfield","CA",35.3733,-119.0187],["Aurora","CO",39.7294,-104.8319],["Anaheim","CA",33.8366,-117.9143],
  ["Honolulu","HI",21.3099,-157.8581],["Santa Ana","CA",33.7455,-117.8677],["Riverside","CA",33.9533,-117.3962],
  ["Corpus Christi","TX",27.8006,-97.3964],["Lexington","KY",38.0406,-84.5037],["Henderson","NV",36.0395,-114.9817],
  ["Stockton","CA",37.9577,-121.2908],["Saint Paul","MN",44.9537,-93.09],["Cincinnati","OH",39.1031,-84.512],
  ["St. Louis","MO",38.627,-90.1994],["Pittsburgh","PA",40.4406,-79.9959],["Greensboro","NC",36.0726,-79.792],
  ["Lincoln","NE",40.8136,-96.7026],["Anchorage","AK",61.2181,-149.9003],["Plano","TX",33.0198,-96.6989],
  ["Orlando","FL",28.5383,-81.3792],["Irvine","CA",33.6846,-117.8265],["Newark","NJ",40.7357,-74.1724],
  ["Durham","NC",35.994,-78.8986],["Chula Vista","CA",32.6401,-117.0842],["Toledo","OH",41.6528,-83.5379],
  ["Fort Wayne","IN",41.0793,-85.1394],["St. Petersburg","FL",27.7676,-82.6403],["Laredo","TX",27.5306,-99.4803],
  ["Jersey City","NJ",40.7178,-74.0431],["Chandler","AZ",33.3062,-111.8413],["Madison","WI",43.0731,-89.4012],
  ["Lubbock","TX",33.5779,-101.8552],["Scottsdale","AZ",33.4942,-111.9261],["Reno","NV",39.5296,-119.8138],
  ["Buffalo","NY",42.8864,-78.8784],["Gilbert","AZ",33.3528,-111.789],["Glendale","AZ",33.5387,-112.186],
  ["Winston-Salem","NC",36.0999,-80.2442],["Chesapeake","VA",36.7682,-76.2875],["Norfolk","VA",36.8508,-76.2859],
  ["Fremont","CA",37.5485,-121.9886],["Garland","TX",32.9126,-96.6389],["Irving","TX",32.814,-96.9489],
  ["Hialeah","FL",25.8576,-80.2781],["Richmond","VA",37.5407,-77.436],["Boise","ID",43.615,-116.2023],
  ["Spokane","WA",47.6588,-117.426],["Baton Rouge","LA",30.4515,-91.1871],["Tacoma","WA",47.2529,-122.4443],
  ["San Bernardino","CA",34.1083,-117.2898],["Modesto","CA",37.6391,-120.9969],["Fontana","CA",34.0922,-117.435],
  ["Des Moines","IA",41.5868,-93.625],["Moreno Valley","CA",33.9425,-117.2297],["Santa Clarita","CA",34.3917,-118.5426],
  ["Fayetteville","NC",35.0527,-78.8784],["Birmingham","AL",33.5207,-86.8025],["Rochester","NY",43.1566,-77.6088],
  ["Oxnard","CA",34.1975,-119.1771],["Salt Lake City","UT",40.7608,-111.891],["Huntsville","AL",34.7304,-86.5861],
  ["Frisco","TX",33.1507,-96.8236],["Grand Rapids","MI",42.9634,-85.6681],["Amarillo","TX",35.222,-101.8313],
  ["Montgomery","AL",32.3668,-86.3],["Akron","OH",41.0814,-81.519],["Little Rock","AR",34.7465,-92.2896],
  ["Augusta","GA",33.4735,-82.0105],["Mobile","AL",30.6954,-88.0399],["Grand Prairie","TX",32.746,-96.9978],
  ["Knoxville","TN",35.9606,-83.9207],["Worcester","MA",42.2626,-71.8023],["Providence","RI",41.824,-71.4128],
  ["Chattanooga","TN",35.0456,-85.3097],["Tempe","AZ",33.4255,-111.94],["Brownsville","TX",25.9017,-97.4975],
  ["Santa Rosa","CA",38.4405,-122.7144],["Fort Lauderdale","FL",26.1224,-80.1373],["Eugene","OR",44.0521,-123.0868],
  ["Cape Coral","FL",26.5629,-81.9495],["Pembroke Pines","FL",26.0078,-80.2963],["Salem","OR",44.9429,-123.0351],
  ["Springfield","MO",37.2090,-93.2923],["Peoria","IL",40.6936,-89.589],["Hartford","CT",41.7658,-72.6734],
  ["New Haven","CT",41.3083,-72.9279],["Bridgeport","CT",41.1792,-73.1894],["Savannah","GA",32.0809,-81.0912],
  ["Columbia","SC",34.0007,-81.0348],["Charleston","SC",32.7765,-79.9311],["Greenville","SC",34.8526,-82.394],
  ["Jackson","MS",32.2988,-90.1848],["Shreveport","LA",32.5252,-93.7502],["Lafayette","LA",30.2241,-92.0198],
  ["Tallahassee","FL",30.4383,-84.2807],["Gainesville","FL",29.6516,-82.3248],["Pensacola","FL",30.4213,-87.2169],
  ["Sarasota","FL",27.3364,-82.5307],["Fort Myers","FL",26.6406,-81.8723],["West Palm Beach","FL",26.7153,-80.0534],
  ["Daytona Beach","FL",29.2108,-81.0228],["Lakeland","FL",28.0395,-81.9498],["Ocala","FL",29.1872,-82.1401],
  ["Wilmington","NC",34.2257,-77.9447],["Asheville","NC",35.5951,-82.5515],["Roanoke","VA",37.2710,-79.9414],
  ["Albany","NY",42.6526,-73.7562],["Syracuse","NY",43.0481,-76.1474],["Allentown","PA",40.6084,-75.4902],
  ["Harrisburg","PA",40.2732,-76.8867],["Scranton","PA",41.4090,-75.6624],["Erie","PA",42.1292,-80.0851],
  ["Dayton","OH",39.7589,-84.1916],["Youngstown","OH",41.0998,-80.6495],["Evansville","IN",37.9716,-87.5711],
  ["South Bend","IN",41.6764,-86.252],["Flint","MI",43.0125,-83.6875],["Lansing","MI",42.7325,-84.5555],
  ["Green Bay","WI",44.5133,-88.0133],["Rockford","IL",42.2711,-89.094],["Springfield","IL",39.7817,-89.6501],
  ["Cedar Rapids","IA",41.9779,-91.6656],["Sioux Falls","SD",43.5446,-96.7311],["Fargo","ND",46.8772,-96.7898],
  ["Billings","MT",45.7833,-108.5007],["Cheyenne","WY",41.14,-104.8202],["Pueblo","CO",38.2544,-104.6091],
  ["Fort Collins","CO",40.5853,-105.0844],["Provo","UT",40.2338,-111.6585],["Las Cruces","NM",32.3199,-106.7637],
  ["Santa Fe","NM",35.687,-105.9378],["Midland","TX",31.9973,-102.0779],["Waco","TX",31.5493,-97.1467],
  ["Tyler","TX",32.3513,-95.3011],["Beaumont","TX",30.0802,-94.1266],["McAllen","TX",26.2034,-98.23],
  ["Abilene","TX",32.4487,-99.7331],["Fort Smith","AR",35.3859,-94.3985],["Fayetteville","AR",36.0626,-94.1574],
  ["Topeka","KS",39.0473,-95.6752],["Columbia","MO",38.9517,-92.3341],["Joplin","MO",37.0842,-94.5133],
  ["Macon","GA",32.8407,-83.6324],["Columbus","GA",32.4609,-84.9877],["Chattanooga","TN",35.0456,-85.3097],
  ["Clarksville","TN",36.5298,-87.3595],["Bowling Green","KY",36.9685,-86.4808],["Charleston","WV",38.3498,-81.6326],
  ["Wilmington","DE",39.7391,-75.5398],["Manchester","NH",42.9956,-71.4548],["Portland","ME",43.6591,-70.2568],
  ["Burlington","VT",44.4759,-73.2121],["Tucson","AZ",32.2226,-110.9747],["Flagstaff","AZ",35.1983,-111.6513],
  ["Palm Springs","CA",33.8303,-116.5453],["Santa Barbara","CA",34.4208,-119.6982],["Redding","CA",40.5865,-122.3917],
  ["Medford","OR",42.3265,-122.8756],["Olympia","WA",47.0379,-122.9007],["Bellingham","WA",48.7519,-122.4787],
  ["Kennewick","WA",46.2112,-119.1372],["Missoula","MT",46.8721,-113.994],["Idaho Falls","ID",43.4917,-112.0339],
  ["Mobile","AL",30.6954,-88.0399],["Tuscaloosa","AL",33.2098,-87.5692],["Lynchburg","VA",37.4138,-79.1422],
];

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, rad = (d) => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Pure: the closest bundled city to a point. → { city, state, miles } | null
function nearestCity(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  for (const [city, state, la, lo] of CITIES) {
    const miles = haversineMiles(lat, lng, la, lo);
    if (!best || miles < best.miles) best = { city, state, miles };
  }
  return best ? { ...best, miles: Math.round(best.miles) } : null;
}

// "~14 mi from Tampa, FL" — the one sentence both surfaces show.
function describeNearestCity(n) {
  if (!n) return "";
  return n.miles < 3 ? `Minutes from ${n.city}, ${n.state}` : `~${n.miles} mi from ${n.city}, ${n.state}`;
}

async function geocode(address) {
  if (!GOOGLE_KEY || !address) return null;
  const q = encodeURIComponent(address);
  try {
    const g = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${GOOGLE_KEY}`).then(r => r.json());
    const loc = g && g.status === "OK" && g.results && g.results[0] && g.results[0].geometry && g.results[0].geometry.location;
    if (loc) return { lat: loc.lat, lng: loc.lng };
  } catch (e) { /* fall through to Street View metadata */ }
  try {
    const m = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${q}&source=outdoor&key=${GOOGLE_KEY}`).then(r => r.json());
    if (m && m.status === "OK" && m.location) return { lat: m.location.lat, lng: m.location.lng };
  } catch (e) { /* no coordinates → no location tile */ }
  return null;
}

const cache = new Map();
async function nearestCityFor(address) {
  const key = String(address || "").trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const pt = await geocode(address);
  const out = pt ? nearestCity(pt.lat, pt.lng) : null;
  if (out) cache.set(key, out); // never cache a miss — a quota blip shouldn't stick
  return out;
}

module.exports = { nearestCity, nearestCityFor, describeNearestCity, haversineMiles, CITIES };
