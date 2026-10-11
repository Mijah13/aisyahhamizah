# SnapCal — a calorie tracker you drive with your camera

Photograph a meal, let Claude read the plate, check the numbers, save it.
No account, no server, no build step: one folder of static files that
GitHub Pages serves as-is.

**Open it at** `https://<your-github-username>.github.io/aisyahhamizah/calories/`

On a phone, use your browser's **Add to Home Screen** — it installs as a
standalone app and opens offline.

## How a meal gets logged

1. **Snap** — the big camera button opens a live viewfinder. No camera, or
   permission denied? *Choose photo* picks one from the gallery, and
   *Add food without a photo* skips the picture entirely.
2. **Analyse** — with an API key saved, *Analyse photo with Claude* sends the
   photo (resized to 1120px) and returns one row per food with an estimated
   portion, calories and macros, each tagged high / medium / low confidence.
   The free-text box next to it carries what the photo can't show
   ("cooked with 2 tbsp oil", "large portion").
3. **Correct** — every field stays editable. Change the gram amount and the
   calories and macros rescale with it. Add anything the photo missed from the
   built-in list of 95 foods, or type your own numbers.
4. **Save** — the meal lands under breakfast / lunch / dinner / snack with its
   photo thumbnail. Tap a meal later to edit or delete it.

## Without an API key

The app is fully usable with no key at all: search the food list, pick a
serving ("1 bungkus", "1 drumstick", "2 slices"), and save. Photos still
attach to the entry — only the automatic reading of them needs a key.

## Turning on photo recognition

1. Create a key at [console.anthropic.com](https://console.anthropic.com)
   and set a low monthly spend limit on it.
2. **Settings → Photo recognition**, paste the key, choose a model, **Save**,
   then **Test key**.

The key is kept in this browser's `localStorage` and is sent only to
`api.anthropic.com`, straight from your device. Nothing passes through any
server of this site. The trade-off is the usual one for a browser-held key:
anything that can run script on the page can read it. Use a spend-limited
key, and clear the field when you're done.

Default model is Sonnet 5.5 — fast and cheap, a few tenths of a US cent per
photo. Opus 5.5 reads crowded plates more carefully; Haiku 5.5 is the
cheapest. A photo costs roughly 1,000–1,600 input tokens.

## Your data

| What | Where | Leaves the device? |
|---|---|---|
| Meals, totals, settings | `localStorage` | No |
| Meal photos (480px) | IndexedDB | No |
| API key | `localStorage` | Only as the `x-api-key` header to api.anthropic.com |
| The photo you analyse | sent once, per tap | Yes — to api.anthropic.com only |

**Settings → Your data** exports everything as JSON or CSV (the export leaves
the API key out), imports a JSON export back, and deletes the lot. Clearing
site data in your browser wipes it just as thoroughly, so export anything you
want to keep.

## Accuracy

These are estimates for everyday awareness, not clinical figures. The food
table holds rounded reference values per 100 g, and a photo estimate is a
judgement from what is visible — depth, hidden rice under a curry, and the oil
a dish was fried in are all guesswork. Treat a day's total as a signal, not a
measurement, and check with a professional before making big changes.

## Files

```
calories/
├── index.html            screens: today, history, settings + two sheets
├── app.js                all logic (vanilla ES modules, no dependencies)
├── styles.css            design tokens, light + dark, mobile-first
├── foods.json            95 foods, per 100 g, with common servings
├── manifest.webmanifest  installable PWA
├── sw.js                 offline app shell — bump CACHE when shell files change
└── icons/
```

### Working on it

```sh
cd calories && python3 -m http.server 8777     # then open localhost:8777
```

A plain file:// open works too, except the service worker and `foods.json`,
which need HTTP.

Chart colours come from a validated palette: categorical slots 1–3
(blue / orange / aqua) for protein / carbs / fat, a single sequential blue for
the daily bars, and reserved status colours for the goal state — each paired
with a label or an icon so colour never carries meaning on its own.
