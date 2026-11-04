# Release notes

One file per version, named after the tag: `v0.1.8.md`. The text is what users see in the update
dialog and on the release page, so write it for them, in Russian, in the first person.

The `Fix update links` job of `origami-build.yml` puts the file into `latest.json` (the `notes`
field the updater shows) and into the release. Add the file in the release commit, before tagging;
without it the stock text stays and the dialog says only that a new version is available.
