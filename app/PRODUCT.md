# Product

<!-- impeccable:product-schema 1 -->

Scope: Switchboard.app, the native macOS front end in `app/`. The service itself is described in `../docs/DESIGN.md`.

## Platform

macOS (native SwiftUI, macOS 14+, arm64). Not one of the skill's mobile platforms; follow macOS Human Interface Guidelines.

## Users
Anyone who installs Switchboard from a downloaded dmg (confirmed 2026-11-15: public audience, no prior context assumed, not necessarily technical). They want their AI assistants ("bots": Claude Code, OpenMausBot) to read their LinkedIn, iMessage and WhatsApp conversations, and to draft replies they approve. They open the app rarely: once to set up, then when something needs attention.

## Product Purpose
Lets a person decide, per channel, whether bots may read nothing, read only, or read and ask to send, and shows whether the background service that does this is healthy. Success: a new user goes from a fresh install to a working channel without Terminal, and always knows what bots can see.

## Positioning
Everything stays on the person's Mac. Switchboard keeps a local copy of messages so bots can search them; switching a channel off deletes that copy. Every send is approved by the person on this Mac.

## Operating Context
Menu bar app (no Dock icon). Settings window opens on first launch and from the menu bar. Setup needs macOS Full Disk Access (System Settings), a LinkedIn sign-in in the browser, and bots configured to talk to Switchboard.

## Capabilities and Constraints
- Channel modes: Off / Read only / Read & write. New installs start with every channel Off.
- The app calls the bundled `switchboard` helper (set-channel, app-setup, doctor) and `allman login`; it reads status.json and config.json. No network calls.
- The UI never shows message text: counts, statuses and dates only.
- status.json reports per-sync counts (messages/threads touched in the last sync), not totals.
- No invented features beyond the brief.

## Brand Commitments
Name: Switchboard. Must look and behave like a proper native macOS app (System Settings grammar), not a web page in a window.

## Evidence on Hand
No screenshots, logos or testimonials. Previews and screenshots use synthetic data only.

## Product Principles
1. Say plainly what bots can see and do, in the user's words, not ours.
2. Deleting is announced before it happens; nothing destructive is a surprise.
3. Every problem names its fix and offers the button for it.
4. Quiet when healthy; the menu bar only speaks up when something needs attention.

## Accessibility & Inclusion
Standard macOS: VoiceOver labels on status icons, full keyboard operation, Dynamic Type-independent but respects system contrast and dark mode.
