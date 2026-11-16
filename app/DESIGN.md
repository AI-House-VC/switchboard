---
name: Switchboard
description: A native macOS control panel for consent over which conversations bots can read and send.
colors:
  accent: "#007AFF"
  good-green: "#34C759"
  attention-orange: "#FF9500"
  destructive-red: "#FF3B30"
  linkedin-blue: "#0A66C2"
  messages-green: "#33C759"
  whatsapp-teal: "#128C7D"
  tile-blue: "#007AFF"
  tile-teal: "#30B0C7"
  tile-brown: "#A2845E"
  tile-gray: "#8E8E93"
  tile-indigo: "#5856D6"
  tile-purple: "#AF52DE"
  tile-glyph: "#FFFFFF"
  icon-blue-top: "#549EFF"
  icon-blue-bottom: "#1A5CE0"
typography:
  welcome:
    fontFamily: "SF Pro (system), -apple-system"
    fontSize: "17pt (.title2)"
    fontWeight: 600
  body:
    fontFamily: "SF Pro (system), -apple-system"
    fontSize: "13pt (.body)"
    fontWeight: 400
  state:
    fontFamily: "SF Pro (system), -apple-system"
    fontSize: "12pt (.callout)"
    fontWeight: 400
  step-number:
    fontFamily: "SF Pro (system), -apple-system"
    fontSize: "12pt (.callout)"
    fontWeight: 600
    fontFeature: "tnum"
  mono:
    fontFamily: "SF Mono (system monospaced)"
    fontSize: "12pt (.callout)"
    fontWeight: 400
rounded:
  tile-ratio: "27% of tile size, continuous"
  tile-sidebar: "5.4pt"
  tile-row: "7pt"
  welcome-mark: "15pt"
  inset-surface: "6pt"
spacing:
  title-stack: "2pt"
  row-inset: "3pt"
  state-gap: "5pt"
  tile-gap-sidebar: "8pt"
  tile-gap-row: "10pt"
  row-trailing-min: "12pt"
  sheet: "20pt"
components:
  icon-tile-row:
    backgroundColor: "{colors.tile-blue}"
    textColor: "{colors.tile-glyph}"
    rounded: "{rounded.tile-row}"
    size: "26pt"
  icon-tile-sidebar:
    backgroundColor: "{colors.tile-blue}"
    textColor: "{colors.tile-glyph}"
    rounded: "{rounded.tile-sidebar}"
    size: "20pt"
  state-line-attention:
    textColor: "{colors.attention-orange}"
    typography: "{typography.state}"
  state-line-good:
    textColor: "{colors.good-green}"
    typography: "{typography.state}"
  step-badge-done:
    backgroundColor: "{colors.good-green}"
    textColor: "{colors.tile-glyph}"
    size: "24pt"
  welcome-mark:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.tile-glyph}"
    rounded: "{rounded.welcome-mark}"
    size: "64pt"
---

# Design System: Switchboard

## Overview

**Creative North Star: "A Pane in System Settings"**

Switchboard is a control panel for consent, built to read as if Apple shipped it: a NavigationSplitView sidebar of coloured rounded-square tiles, grouped Form sections, the system font, SF Symbols and semantic system colours. The per-channel segmented choice (Off / Read only / Read & write) is the product; every other element exists to make that choice safe or to unblock it.

Density is System Settings density: one Form row per thing, each row a tile, a title, one state sentence, an optional inline fix link, and one trailing control. Explanation lives in section footers in secondary text, never in banners or cards. The window is quiet when healthy; colour appears only where something is done (green) or needs doing (orange).

The only owned artwork is the glyph: three jacks patched into one, drawn in code as a template image for the menu bar (tinted by macOS) and reused on the blue app icon and the welcome mark.

**Key Characteristics:**
- System Settings grammar: sidebar tiles, `Form` with `.grouped` style, page title in the window title.
- System font and SF Symbols only; no bundled fonts or icon sets.
- Semantic colour for state; identity tint only on tiles.
- Every problem state carries its fix inline as a link-style button.
- Content stays out: counts, states and dates, never message text.

## Colors

Semantic macOS colours carry all state; fixed tints exist only on icon tiles. Hex values are the light-mode system values; in code the system colours are referenced by name (`.green`, `.orange`, `Color.accentColor`) so they adapt to dark mode and increased contrast.

### Primary
- **System Accent** (accent): the user's macOS accent. Default buttons, link-style fix buttons, the welcome mark's fill. Never replaced with a brand colour.

### Secondary
- **Done Green** (good-green): `checkmark.circle.fill` on healthy state lines and the filled circle of a completed setup step.
- **Attention Orange** (attention-orange): `exclamationmark.triangle.fill` on state lines that need action, and the 7pt dot beside a sidebar page that needs attention.
- **Destructive Red** (destructive-red): only via `role: .destructive` on the "Turn Off and Delete Copy" alert button; never set by hand.

### Tertiary (tile tints)
- **LinkedIn Blue**, **Messages Green**, **WhatsApp Teal** (linkedin-blue, messages-green, whatsapp-teal): fixed RGB channel identity tints, defined once on `Channel.tint`. Used only as tile fills, wherever that channel appears.
- **Page tiles** (tile-teal Get Started, tile-blue Channels, tile-gray Setup, tile-indigo Connect Your Bots) and **row tiles** (gray service, blue Full Disk Access, brown Claude Code, purple OpenMausBot): system colours, filled with `.gradient`, white SF Symbol on top.
- **Icon Blue** (icon-blue-top to icon-blue-bottom): app icon squircle gradient only, generated by `dev/make-icon.swift`.

### Neutral
- Text is `.primary` for titles and `.secondary` for state lines, details and footers; `.quaternary` fills an unfinished step badge; `.background.secondary` backs the diagnostics output. No custom greys.

### Named Rules
**The Quiet-When-Healthy Rule.** Neutral and good states read in secondary text. A state line switches to primary text only for `attention`, so the one thing to fix is the darkest sentence on the page.

**The Tint-Is-Identity Rule.** Tile tints name a thing (a channel, a page, a bot). They never signal state. State goes through StateLine and its symbols.

## Typography

**Display Font:** none. System font (SF Pro) throughout.
**Label/Mono Font:** system monospaced, only for the setup block and diagnostics output, which are meant to be copied.

**Character:** Apple's text styles at macOS sizes, left as the system sets them; hierarchy comes from colour (primary vs secondary) more than size.

### Hierarchy
- **Welcome** (600, `.title2`): the single welcome line on Get Started. The only heading the app draws itself.
- **Title** (400, `.body`): row titles, step titles. Native Form section headers ("Set up Switchboard") are the system's own.
- **State** (400, `.callout`): StateLine sentences, step details, link-style fix buttons, footers.
- **Step number** (600, `.callout`, monospaced digits): inside the step badge.
- **Mono** (400, `.callout` monospaced): copyable machine text only.

### Named Rules
**The Sentence-State Rule.** Status is a short plain sentence in the user's words ("Needs Full Disk Access", "Synced 5 min ago · 12 new"), never a code, badge or number on its own.

## Layout

Window minimum 800 x 480pt; sidebar 215pt (up to 260pt). Detail is a `.grouped` Form, so section insets, row separators and footers are the system's. Inside rows: tile, a 2pt-spaced stack of title / state / fix, a flexible spacer of at least 12pt, then the trailing control; rows add 3pt vertical padding. Sidebar rows use a 20pt tile with an 8pt gap. Sheets pad 20pt. Pages are vertical lists only: no grids, no columns of cards, no stat tiles.

## Elevation & Depth

Flat, as System Settings is. Depth comes only from the system: grouped Form section backgrounds, the split view, sheets and alerts. The app draws no shadows in its UI; the drop shadow under the app icon squircle belongs to the macOS icon grid, not the interface.

## Shapes

Continuous-corner rounded squares everywhere a shape is drawn. Icon tiles use a radius of 27% of their size (5.4pt at 20pt, about 7pt at 26pt). Step badges are 24pt circles. The diagnostics output sits on a 6pt continuous rectangle. Controls (segmented pickers, push buttons, toggles) keep their native shapes.

## Components

### Icon Tile
A rounded square filled with its tint's system gradient and a white SF Symbol at 52% of the tile size, semibold. 20pt in the sidebar, 26pt in Form rows. Hidden from accessibility; the row title carries the name.

### StateLine
A `.callout` sentence with an optional leading symbol by tone: `good` green check circle, `attention` orange triangle (and primary text), `busy` mini progress spinner, `unavailable` secondary minus circle, `neutral` no symbol. Combined into one accessibility element.

### SettingRow (signature component)
The page vocabulary: Icon Tile, title, StateLine, an optional fix underneath, then a trailing control. On Channels the trailing control is the segmented Off / Read only / Read & write picker (labels hidden, fixed size); elsewhere a single push button ("Open Privacy Settings…", "Restart", "Connect"). Fixes under the state line are `.link` buttons in `.callout`, named after the action they take.

### Buttons
Native push buttons with Title Case labels; an ellipsis when the button opens something else (another app, the browser, a sheet). Default action takes `.defaultAction`. Destructive confirmation uses an alert with `role: .destructive`, and Cancel holds the default key when the action deletes.

### Setup Step
Get Started's checklist row: 24pt circle badge (quaternary with a monospaced number, or green with a white bold checkmark when done), title and secondary detail, trailing action button that disappears when done. Done transitions animate with `easeOut` over 0.2s.

### Navigation
Sidebar list with page tiles, Title Case page names, and a 7pt orange dot trailing any page that needs attention. The window title follows the selected page.

### Menu Bar
A template image (18pt), never coloured, so macOS tints it. Needing attention cuts a ring out of the cords at top right and fills a dot inside it. The menu is plain text lines: a one-sentence headline, one line per channel (`Name: mode · problem`), "Open Switchboard…" and "Quit Switchboard…" (which confirms first).

## Do's and Don'ts

### Do:
- **Do** build every new setting as a SettingRow inside a `.grouped` Form section, with explanation in the section footer (`.callout`, secondary).
- **Do** pair every attention state with the button that fixes it, inline under the state line.
- **Do** confirm, with an alert that says what is deleted and what is not, before any change that deletes data or widens what bots can do.
- **Do** keep the menu bar glyph a template image so it follows the menu bar's appearance.

### Don't:
- **Don't** put tile tints on text, state symbols or controls; state colour comes only from StateLine tones.
- **Don't** set colours by RGB outside `Channel.tint` and the icon generator; use system semantic colours.
- **Don't** show message text, sender content or totals as heroes: counts, states and dates only, in sentences.
- **Don't** add dashboard furniture (stat tiles, charts, custom cards) or custom shadows; this is a settings pane.
