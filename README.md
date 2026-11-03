# Herdr OneDev Issues

A [Herdr](https://herdr.dev) mod that lists the OneDev issues of the repository the focused terminal is in. You can read an issue, comment on it, move it to another state and edit its fields without leaving Herdr.

**Status:** in development. Nothing here works yet.

## How it works

The mod gets all its data from `odev`, a command line client for OneDev, which will be published on GitHub before this mod works. The mod never handles a OneDev token itself.

## Credits

The design follows [herdr-issues](https://github.com/jankeesvw/herdr-issues) by Jankees van Woezik, which does the same for GitHub issues through `gh`. This mod is built fresh from that mod's `RECIPE.md`, for OneDev's states, custom fields and query language.

## Licence

MIT. See [LICENSE](LICENSE).
