# aisyahhamizah_site

A Jekyll site, plus **[SnapCal](calories/)** — a calorie tracker you drive with
your camera: photograph a meal, have Claude read the plate, check the numbers,
save it. It runs entirely in the browser, installs to a phone home screen, and
keeps all data on the device. See [`calories/README.md`](calories/README.md).

## Running the site locally

```sh
bundle install
bundle exec jekyll serve
```

The tracker is at `/calories/`, and also works on its own:

```sh
cd calories && python3 -m http.server 8777
```

> **Note** — `index.html` and `index.markdown` both build to `/index.html`, so
> Jekyll reports a conflict and one of them silently wins. Deleting whichever
> one you don't want clears it.
