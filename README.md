# Sun Times

Sunrise, sunset, golden hour and day length for any place on Earth — in that
place's own local time. Pick somewhere by searching for a city, clicking the
map, or using your browser's location.

Plain HTML, CSS and ES modules. No build step, no bundler, no dependencies, no
API keys, no analytics.

## Running it

ES modules are blocked over `file://`, so it needs a server — any server:

```sh
npm run serve          # python -m http.server 8000
```

Then open <http://localhost:8000/>. There is nothing to install first;
`package.json` exists only to hold the two scripts and to tell Node that `.js`
files here are modules.

## How it works

### The sun is computed, not fetched

`js/sun.js` implements the NOAA solar algorithm. Sunrise/sunset APIs exist, but
doing the arithmetic locally means the date picker re-renders instantly, any
date in any year works, there are no rate limits, and once the page has loaded
the whole thing keeps working offline. The network is only ever used to *find* a
place, never to ask about the sun.

Events are parameterised by solar altitude, so one routine yields all of them:
sunrise and sunset at **−0.833°** (atmospheric refraction plus the sun's own
radius), and the golden-hour boundaries at **+6°**. Polar cases fall out of
`cos ω₀` leaving [−1, 1] and are reported as `midnight-sun` or `polar-night`
rather than as `NaN`.

Accuracy against published almanac times for London is within **0.5 minutes** at
both solstices. An independent check through the sun's right ascension agrees
with the main path to under 7 seconds.

### Times are in the place's own clock

Everything internal is a UTC instant. Display goes through
`Intl.DateTimeFormat` with the place's IANA zone, so daylight saving is the
platform's problem rather than ours. Tokyo's sunrise reads as 06:15 whoever is
looking.

The solar day is anchored on the place's *political* noon where its zone is
known, not on its longitude. That distinction is not academic: Kiritimati sits
at 157°W but keeps UTC+14, and anchoring on longitude puts its sunrise on the
wrong calendar day.

Where a zone cannot be established, the app falls back to the viewer's own zone
**and says so on the place line**, rather than labelling times with a zone
nobody checked.

### Finding a place

| What | Service | Key needed |
| --- | --- | --- |
| City search | [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api) | no |
| Time zone for a point | [Open-Meteo forecast](https://open-meteo.com/) (`timezone=auto`) | no |
| Name for a point | [BigDataCloud reverse geocode](https://www.bigdatacloud.com/) | no |
| Map tiles | [OpenStreetMap](https://www.openstreetmap.org/) via Leaflet 1.9.4 | no |

Requests are deliberately sent with no custom headers: any would make them
non-simple, and the browser would then send a CORS preflight that the geocoding
host answers with a 404.

Every one of these can fail without taking the app down. Leaflet blocked by a
CDN filter leaves a map area that explains itself and three other working ways
in; a failed reverse lookup leaves coordinates as the label; a failed zone
lookup is stated rather than hidden.

### State

The current view is mirrored into the URL
(`?lat=&lon=&name=&region=&tz=&date=`) with `replaceState`, so a reload keeps
it and the link can be shared. The date is left out when it is simply "today",
so a shared link shows the recipient *their* today.

Pinned places and the last place seen live in `localStorage`. Startup order is
**URL → last place → nothing**: a link someone was sent has to beat whatever
this browser happens to remember. Geolocation is deliberately not in that
chain, because a permission prompt nobody asked for is a bad way to open a
page.

Nothing from either source is trusted. A URL is editable by anyone and
`localStorage` can hold whatever else is on the origin, so every value is
validated and a damaged row is dropped while the rest are kept.

### Files

```text
index.html          markup
css/styles.css      tokens, light + dark, responsive
js/sun.js           the solar algorithm (pure, no DOM, no network)
js/time.js          IANA zone arithmetic via Intl
js/format.js        times, durations, coordinates, zone labels
js/places.js        search, geolocation, zone and name lookups
js/map.js           Leaflet setup and the marker
js/store.js         localStorage and URL state
js/app.js           state, rendering, event wiring
test.html           the suites, in a browser
.nojekyll           GitHub Pages: serve the files as they are
```

## Tests

```sh
npm test               # all suites in Node
```

Or open <http://localhost:8000/test.html> for the same checks in a browser,
failures first.

**342 checks.** The solar ones are the interesting part: as well as published
almanac times, they assert physical identities that any correct implementation
has to satisfy — that the sun is actually on the horizon at the moment sunrise
is claimed, that equinox days last about 12h07m at every latitude, that solar
noon stays within the equation of time of mean noon, that day lengths mirror
across the equator. Each check reports the value it measured, so one that
passes by luck is still visible.

The API parsers are tested against **responses recorded from the live
services**, which is how several quirks were found rather than guessed at: a
query with no matches omits `results` entirely instead of sending an empty
array, a city-state carries no `admin1`, and the reverse geocoder returns empty
strings rather than nulls — so presence checks would have accepted nothing at
all.

## Accessibility

Light and dark are both first-class, and every colour pairing the page makes
has been measured against WCAG AA — 44 of them, at the threshold for each one's
size, weight and whether it is text at all. Several needed changing to get
there: links and focus rings no longer share a token with the primary button's
fill (a mid amber is fine as a fill and reads at 2.85:1 as body text), `--rose`
is theme-specific because no single red clears both a white and a dark panel,
and form fields have their own stronger border, since the edge that tells you
something is a text field owes 3:1 while a panel edge is only decoration.

The tightest pairings are the footer link at 4.85:1 and the dark-mode masthead
tagline at 4.71:1.

**Known follow-up:** the footer links in light mode have been measured at
4.85:1 but not yet confirmed by eye. They are the smallest text on the page
(13px) in the deepest accent colour, so they are the most likely place for the
numbers to be right and the result still to read poorly.

## Publishing to GitHub Pages

It is a static site, so this is the whole job:

```sh
gh repo create sun-times --public --source=. --remote=origin --push
```

Then turn Pages on, pointing at the root of the default branch:

```sh
gh api -X POST repos/:owner/sun-times/pages \
  -f 'source[branch]=master' -f 'source[path]=/'
```

Use the branch you actually pushed — `git branch --show-current` will say. (Or
in the repository on github.com: **Settings → Pages → Deploy from a branch →
that branch / (root)**.)

The site appears at `https://<user>.github.io/sun-times/` within a minute or
so. Geolocation needs a secure origin, which Pages provides; it will not work
over plain HTTP.

## Licence

MIT.
