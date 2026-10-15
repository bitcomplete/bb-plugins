# Image Copy

Adds a Copy Image icon inside chat messages, immediately after each image link's ↗ icon. Click it, then paste into another app with ⌘V / Ctrl+V. Copies the full image to the clipboard on the device where BB is open, including remote HTTPS clients.

Supports image links ending in PNG, JPEG, WebP, GIF, AVIF, BMP, SVG, and ICO. Local file links load through BB's SDK on the thread's workspace host or thread-storage host, with the corresponding read root enforced. Other browser-supported formats are converted to PNG for clipboard compatibility.

```sh
npm ci
npm test
npm run typecheck
bb plugin build
bb plugin install . --yes
```

Requires an HTTPS or localhost client with the image Clipboard API enabled. Permission or image loading failures appear beside the link. External image servers must permit cross-origin fetching. Animated images copy as a single frame.

The app overlay supplies the current thread and public SDK to the DOM enhancement. It depends on BB's current chat link markers; recheck them when BB changes its message rendering. Disabling the plugin or changing threads removes its controls and observer. There are no settings or backend operations.
