# Design system — "Navy Slate"

Premium, minimal, technology-driven: white cards on a cool pale slate ground, near-black ink for
headings and structural surfaces, and **dark blue for actions and positive status**. Green is not
used as a brand or success colour. No gold, no neon, no gradient fills, no heavy shadows.

The same tokens drive all three surfaces — the customer app, the driver app and the admin
dashboard — so neither can drift.

| Surface | How it reads the tokens |
| --- | --- |
| `apps/mobile` (customer + driver) | `theme` from `@drivx/design-tokens`, provided once by `ThemeProvider` in `apps/mobile/src/app/_layout.tsx`; components call `useTheme()` |
| `apps/admin` | `cssVariables()` in `packages/design-tokens/src/web.ts` is injected as `<style id="drivx-tokens">` by `app/layout.tsx`, and `app/globals.css` maps those `--dx-*` custom properties onto Tailwind v4 utility names through `@theme inline` |

The token package is consumed **as TypeScript source** (`main: ./src/index.ts`, no build step), so
an edit is live in the next compile rather than after a bundler run.

---

## 1. Colour

### Roles components actually use

Nothing in `apps/` or `packages/ui/` hardcodes a hex value; each of these is a role.

| Role | Hex | Used for |
| --- | --- | --- |
| `background` | `#F8FAFC` | Page ground, screen container, cold-start window background |
| `surface` | `#FFFFFF` | Cards, sheets, inputs, tab bar |
| `surfaceMuted` | `#F1F5F9` | Inset panels, grouped rows, pressed secondary button |
| `surfaceBrand` | `#0F172A` | Admin navigation, the brand header band, the live-trip card |
| `border` | `#E2E8F0` | Card and sheet hairlines, dividers, loading shimmer ground |
| `borderFocus` | `#1E40AF` | The 2px ring on a focused input, control or link |
| `text` | `#334155` | Body copy |
| `textMuted` | `#64748B` | Secondary copy, inactive tab labels, on white and on the ground |
| `textFaint` | `#475569` | Small print that must survive a tinted ground — timestamps, footnotes, field helpers |
| `textBrand` | `#0F172A` | Every heading, and the label of a non-blue primary-looking control |
| `textOnBrand` | `#FFFFFF` | Text on `surfaceBrand` |
| `primary` | `#1E40AF` | Primary button fill, active tab icon, focus ring, selected chip border, map pickup marker |
| `primaryPressed` | `#0F2A5A` | Pressed primary button |
| `primaryInk` | `#1E40AF` | **Blue that is read, not pressed** — a ghost action's label, a selected chip's text, the active tab's label |
| `primarySoft` | `#EEF2FF` | Pale blue: selected chip fill, positive badge ground, pressed ghost |
| `infoSoft` | `#EFF6FF` | Informational ground — deliberately blue, see §Two rules |
| `onPrimary` | `#FFFFFF` | Label on a dark-blue fill |
| `neutralAction` | `#0F172A` | Ink-filled button: the dark active pill, a confirmation that is not the blue one |
| `neutralActionPressed` | `#020617` | Its pressed state |
| `disabledSurface` | `#E2E8F0` | Disabled control fill |
| `disabledText` | `#94A3B8` | Disabled control label |
| `success` / `successSoft` | `#1E40AF` / `#EEF2FF` | Verified, completed, online |
| `warning` / `warningSoft` | `#B45309` / `#FEF3C7` | Pending, low balance, needs attention |
| `danger` / `dangerSoft` | `#DC2626` / `#FEE2E2` | Cancelled, rejected, invalid input |
| `dangerPressed` | `#B91C1C` | Pressed destructive action |
| `skeleton` | `#E2E8F0` | Loading shimmer ground |

`statusInk` (`neutral` / `info` / `success` / `warning` / `danger`) is the badge foreground
namespace, keyed to match the `*Soft` ground behind it.

### Two rules that hold the hierarchy together

1. **Emerald marks only an action, a selection, a focus ring or an all-clear status.** Never a
   decorative icon, never a section label, never "every accent on the screen". A screen with three
   green things is a screen with nothing to press.
2. **Headings read as `textBrand` (near-black slate ink), not green.** This is what stops every
   emerald implementation turning into a green app.

`primary` and `primaryInk` are the *same* value, which is the whole point of the palette choice.
Bright emerald is the colour people mean by "premium green" and none of it survives a contrast
meter: `#10B981` on white is 2.54:1 and white on `#059669` is 3.77:1, both under AA. Emerald 700
(`#047857`) is the first step of that hue that carries text — 5.48:1 on white, 5.21:1 on its own
tint — so the fill and the read-green are one colour and no label has to be lightened to fit.

`#10B981` is still in the palette as `brandBright`, for exactly one job: the live/online dot, which
is always paired with the state written in words beside it.

Where a status is *informational* rather than positive, it stays blue (`infoSoft` `#EFF6FF` with
`statusInk.info` `#1D4ED8`). Under this palette green means "act on it" or "all clear", so a neutral
pill on a green tint reads as a success message — that collision is why `StatusPill`'s `info` tone
does not use `primarySoft`.

### Support tones

`#047857`, `#065F46`, `#10B981`, `#ECFDF5`, `#0F172A`, `#020617`, `#F8FAFC`, `#FFFFFF`, `#334155`,
`#64748B`, `#475569`, `#E2E8F0`, `#F1F5F9`, `#94A3B8`, `#B45309`, `#DC2626` and `#1D4ED8` are the
palette and are pinned by name in `scripts/check-contrast.mjs` — editing one fails a command.

The remaining support tones are not new colours; each is one of those hues moved a step, added only
where the mandated value cannot carry text:

| Tone | Why it exists |
| --- | --- |
| `warningDeep` `#92400E`, `errorDeep` `#B91C1C`, `brandDeep` `#065F46` | a status colour at full strength on its own soft tint measures 4.8–5.5:1 at best and worse at some pairs; a badge is 12px and needs the darker step |
| `infoDeep` `#1D4ED8` | blue is the informational hue here, and `#2563EB` on `#EFF6FF` is 4.9:1 — fine for a fill, not for 12px badge text (6.16) |
| `inkTint` `#1E293B` | a raised row inside a `surfaceBrand` panel needs to separate from the band without a border |

`scrim` (`rgba(15,23,42,0.45)`) and `hairline` (`rgba(15,23,42,0.08)`) are slate ink with alpha, for
overlays and dividers that must read on either ground.

### The DrivX mark

The supplied artwork arrived as a PNG with its **transparency checkerboard painted into the pixels**
— every one of the 1.08 M of them opaque — so it could not be dropped onto a surface as-is.
`scripts/make-brand-assets.mjs` keys it out: the mark sits at luminance 24–47 and the two checker
tones at 208–255, with nothing in between, so alpha is a ramp across that empty band, which keeps the
anti-aliased edge and discards the grid. The mark is then repainted in `palette.ink` rather than kept
in its own near-black, because a logo a few units off the token the headings use reads as a second
brand. Two masters come out of it:

| File | Ground | Used by |
| --- | --- | --- |
| `assets/logo-mark.png` | transparent, ink mark | light surfaces |
| `assets/logo-mark-light.png` | transparent, white mark | the ink tiles: `BrandMark`, which is what `BrandBar`, sign-in and the driver Duty header render |
| `assets/logo-mark-source.png` | transparent, 1024, mark at 80% | the master every icon is scaled from |

Everything else is derived from that master and regenerated with
`node scripts/make-brand-assets.mjs <path-to-logo.png>`: the iOS icon and Android adaptive
foreground/background/monochrome (white mark on an ink ground — the launcher crops a circle, so the
mark stays at half the frame), the splash mark (ink, on the pale ground `app.json` declares), and the
favicons (ink tile, mark at 74% — smaller and the gap under the arrow fills shut at 48px).

`BrandMark` is the ink tile plus the white glyph, and it is the only place that require()s the asset in
the mobile app: the customer `BrandBar`, the sign-in lockup and the driver Duty header each scale it
(44, 56, 44). The admin header band uses `next/image` on a copy served from `apps/admin/public/`, and
`apps/admin/app/icon.png` is the console favicon. The mark replaced the placeholder compass glyph in
`BrandBar`, so the tile keeps its `surfaceBrand` ink ground and only the picture inside it changes. A
new or renamed asset is not picked up by a live Metro session — restart it with `--clear`.

The mobile app's own browser tab needs `apps/mobile/public/favicon.ico`: `app.json`'s `web.favicon` is
only written into a static export, while a browser asks the dev server for `/favicon.ico` unprompted and
would otherwise get Expo's template icon. The script wraps a 64px PNG in an ICO container by hand
because the sharp build here has no ICO encoder.

---

## 2. Type

One family throughout: **Plus Jakarta Sans**, declared as a family with five real faces
(400/500/600/700/800) in `apps/mobile/src/app/_layout.tsx`, so `fontWeight: '700'` selects the bold
file on iOS and Android and a matching `@font-face` on web, instead of synthesising bold from the
regular cut. Nothing paints before the faces arrive. The admin loads the same five weights through
`next/font/google`.

Jakarta over Inter is a deliberate move: the brief asked for something that reads premium and Indian
at once, and Jakarta's rounder terminals let a heading carry more weight at the same size. That is
why `display`, `title` and `fare` take the 700 cut and the wordmark takes 800 — Inter could not hold
31px at that density without going loud.

| Variant | Size / weight / tracking | Used for |
| --- | --- | --- |
| `display` | 31 / 700 / −0.8 | Page heading — "Where would you like to go?", "Operations console" |
| `title` | 26 / 700 / −0.6 | Screen heading |
| `fare` | 28 / 700 / −0.5 | The one number a customer reads before anything else |
| `heading` | 19 / 600 / −0.2 | Section heading |
| `subheading` | 17 / 600 / −0.1 | Card title |
| `body` / `bodyStrong` | 15 / 400 or 600 | Copy |
| `label` | 13 / 500 / +0.1 | Form labels |
| `caption` | 13 / 400 | Helper and secondary copy |
| `overline` | 12 / 700 / +0.8 | Eyebrows, uppercase section kickers |
| `button` | 15 / 600 / −0.1 | Button labels |
| `wordmark` | 13 / 800 / +1.6 | DrivX, uppercase, tracked — the existing wordmark, not a new logo |

Fares and money are integers in **paise**, formatted with `Intl` `en-IN`, so ₹ appears with Indian
digit grouping everywhere.

---

## 3. Space, shape, elevation

Spacing is an **8-point baseline** — 8, 16, 24, 32, 48, 64, with 4 and 12 as half-steps for icon
gaps and dense rows. Every padding, margin and gap in the three surfaces comes from
`theme.spacing`; a layout that needs a number not on the scale is a sign the layout should change
instead.

| Token | Value |
| --- | --- |
| `radius.sm` / `md` / `lg` / `xl` | 8 / 12 / 16 / 20 |
| Cards and sheets | `radius.lg` (16) — nothing is rounder; no oversized rounded rectangles everywhere |
| Controls (buttons, inputs, chips) | `radius.md` (12) |
| `pill` | 999, reserved for badges and status chips, not a default button shape |
| `borderWidth` | hairline 0.5 / thin 1 / **focus 2** |
| `touchTarget` | 44 (every control's `minHeight`) |
| `inputHeight` | 52 |
| `buttonSm` / `buttonLg` | 40 / 56 |
| `navBarHeight` | 64 |
| `screenGutter` | 20 |

Elevation is restrained: a card is carried by its 1px `#E2E8F0` border plus at most a 1px/4%-opacity
shadow in slate ink (`#0F172A`). Only what genuinely floats — a sheet, the sticky live-trip bar —
gets the 4px/8% or 8px/12% preset. The web preset in `webShadow` mirrors the native one so the two
surfaces cast the same shadow.

Icons are one family: **Ionicons in the `-outline` cuts only** (`car-outline`, `time-outline`,
`person-outline`, `radio-outline`, `document-text-outline`, `wallet-outline`), tinted through
`theme.colors`, never a filled/outline mix.

---

## 4. Components

`packages/ui` holds the primitives both roles share. Each resolves its states from **colour rather
than opacity**, so "tap to confirm" and "this cannot be tapped" are legible without guessing.

| Primitive | States |
| --- | --- |
| `Button` — `primary` / `brand` / `secondary` / `ghost` / `danger`, sizes sm/md/lg | rest, pressed, focused (2px emerald ring), disabled, loading (`ActivityIndicator` in the label colour), `selected` (emerald mist fill, emerald border, `primaryInk` label) |
| `Field` | label above the field, never a placeholder carrying information; border is the state — 1px `border` at rest, 2px `borderFocus` while focused, 2px `danger` with an inline message below |
| `Card` — `raised` / `flat` / `brand` / `inset` | white on hairline border, ink-dark for the live trip, inset for notes and footers |
| `Text` | 11 variants × 8 tones; leading and tracking scale with the device font size (see §6) |
| `StatusPill` | five tones, foreground from `statusInk`; `info` sits on blue `infoSoft`, not on the emerald mist |
| `Screen`, `ScreenHeader`, `StateView`, `Toggle` | page container and gutter; eyebrow + title + subtitle header, which wraps rather than clips; loading / empty / error states; the platform switch coloured from the theme, with `activeThumbColor` set for the web build, which otherwise paints the thumb Material teal |
| `SectionCard` — `icon` / `title` / `action` / `footer` | the reference screen's card: white, `radius.xl`, hairline border, uppercase letterspaced `faint` title, one right-hand action, body gap, optional footer strip |
| `SegmentedTabs` — `filled` / `card` / `ink` | single-select row of segments with optional icon and badge; `filled` is the mode switch (grey ground, ink active block), `card` the in-card tabs, `ink` the account rail. A disabled segment keeps its reason in `accessibilityLabel`, so "DrivX cab" explains itself instead of looking broken. **Each segment sets `flexBasis: 150` with `minWidth: 0`** — a one-line label gives a flex item an intrinsic width, and without those the three service names measure ~683px and push the whole page past the viewport |
| `SelectBox` | the press-to-expand field box: tiny uppercase label, `bodyStrong` value, leading icon, trailing affordance; `expanded` gains the 2px focus border, `disabled` uses `disabledSurface` |
| `OptionCard`, `Chip` | the two selection shapes. `OptionCard` is a radio card (dot, title, optional note, right icon) for the choice that decides the booking; `Chip` is multi-select. Selected = white ground + 2px emerald border rather than a colour change, so a row of them stays legible on a screen that already uses emerald for actions |
| `Tag` | small rounded tag in `success` / `neutral` / `onBrand` / `outline`, with an optional `brandBright` dot or icon; `onBrand` is the pale-emerald tag that reads on the ink rail |

Two composites sit above the package because they belong to the customer app, not to every screen:

- `src/components/BrandBar.tsx` — ink tile with a `brandBright` compass glyph, the "DrivX." wordmark
  at `title`/800/-0.8 tracking, a `PREMIUM` outline tag and the account rail. The rail is a
  *statement* of who is signed in, not a switch: a role is a claim on the ID token, so "DrivX
  Partner" and "Admin Console" render disabled with the sentence that explains why.
- `src/features/customer/AvailabilityPanel.tsx` — the right-hand HUD: real online-driver count, a
  **schematic** route box (rotated dashed line, two endpoint markers, no map tiles), and DISTANCE /
  EST. TIME / FARE columns from the server quote. It uses `flexGrow` with an explicit `flexBasis`,
  never `flex: 1`: inside a column of auto height a zero basis collapses the box to 0 while its
  content keeps painting, which is how it came to overlay the Confirm button. Every unbacked promise
  the reference mockup invents — wallet balance, coupon, drive time, live map, 32 drivers nearby —
  occupies the slot it would have occupied and says it is not live, in the same type size.

Both tab bars are expo-router `Tabs`, styled from the tokens in
`apps/mobile/src/app/(customer)/_layout.tsx` and `(driver)/_layout.tsx`: white bar, 1px `border`
top line, 64px tall, active icon and label in `primaryInk`, inactive in `textMuted`.
`tabBarLabelStyle` is set explicitly because react-navigation draws its own label with no font —
without it the one line of text in the bar renders system-ui at ~10px while everything around it is
Jakarta, which is exactly what it was doing before this pass.

`BottomNav.tsx` is exported from `@drivx/ui` but **used by neither app** for the same reason. It
is restyled with the rest of the package and left in place; deleting it is cleanup outside a
redesign.

The admin uses the Tailwind names mapped in `app/globals.css` (`bg-surface`, `text-ink`,
`text-ink-muted`, `text-ink-faint`, `border-line`, `bg-accent`, `bg-info-soft`,
`text-badge-success`, `rounded-card`, `shadow-card`, …). They resolve to the same `--dx-*` variables
the mobile app reads.

---

## 5. Measured contrast

`npm run check:contrast` recomputes every pair below from the shipped tokens — 35 pairs plus the 17
pinned palette hexes. It runs on Node's built-in TypeScript stripping and a `module.registerHooks`
resolve hook, so it needs **no new dependency**.

AA is 4.5:1 for normal text, 3:1 for large text (≥24px, or ≥18.66px bold). WCAG 1.4.3 excludes
inactive interface components, and 1.4.11 sets 3:1 for non-text UI *shapes* rather than hairlines
whose purpose is carried elsewhere.

```
  ok   10.35  body on card                   15 body              #334155 on #FFFFFF
  ok    9.90  body on page ground            15 body              #334155 on #F8FAFC
  ok   17.06  heading on page ground         31 display           #0F172A on #F8FAFC
  ok   17.85  card title on card             17 subheading        #0F172A on #FFFFFF
  ok    4.76  secondary text on card         13 caption           #64748B on #FFFFFF
  ok    4.55  secondary text on page ground  13 caption           #64748B on #F8FAFC
  ok    7.58  small print on card            13 caption           #475569 on #FFFFFF
  ok    6.92  small print on inset panel     13 caption           #475569 on #F1F5F9
  ok    7.19  small print on emerald tint    13 caption           #475569 on #ECFDF5
  ok   17.85  text on ink surface            19 heading           #FFFFFF on #0F172A
  ok   14.63  text on ink row                19 heading           #FFFFFF on #1E293B
  ok    5.48  primary button label           15 semibold button   #FFFFFF on #047857
  ok    7.68  pressed primary label          15 semibold button   #FFFFFF on #065F46
  ok   17.85  secondary (ink) button label   15 semibold button   #0F172A on #FFFFFF
  ok   17.85  label on the dark active pill  13 active pill       #FFFFFF on #0F172A
  ok    5.48  ghost (emerald) action on card 15 button            #047857 on #FFFFFF
  ok    5.24  ghost (emerald) action on ground 15 button          #047857 on #F8FAFC
  ok    5.21  selected chip label on tint    13 selected chip     #047857 on #ECFDF5
  ok    5.48  active tab label               13 tab label         #047857 on #FFFFFF
  ok    4.76  inactive tab label             13 tab label         #64748B on #FFFFFF
 note   2.08  disabled control label         15 disabled          #94A3B8 on #E2E8F0
  ok    9.45  neutral badge                  12 badge             #334155 on #F1F5F9
  ok    6.16  info badge (blue, not green)   12 badge             #1D4ED8 on #EFF6FF
  ok    7.29  success badge                  12 badge             #065F46 on #ECFDF5
  ok    6.37  warning badge                  12 badge             #92400E on #FEF3C7
  ok    5.30  danger badge                   12 badge             #B91C1C on #FEE2E2
  ok    5.48  success text on card           13 caption           #047857 on #FFFFFF
  ok    5.02  warning text on card           13 caption           #B45309 on #FFFFFF
  ok    4.83  danger text on card            13 caption           #DC2626 on #FFFFFF
 note   1.23  resting input border           1px line             #E2E8F0 on #FFFFFF
  ok    4.83  invalid input border           2px line             #DC2626 on #FFFFFF
  ok    5.48  focus ring against card        2px ring             #047857 on #FFFFFF
  ok    5.21  switch thumb against track, on switch, on           #047857 on #ECFDF5
 note   1.13  switch thumb against track, off switch, off         #F1F5F9 on #E2E8F0
 note   2.54  live/online dot                8px dot              #10B981 on #FFFFFF
```

Every text pair clears AA on this palette, which was not true of the previous one. The four `note`
rows are the pairs that cannot be moved without breaking the design language or the platform
control, each exempt for a stated reason rather than quietly dropped:

- **disabled control label — 2.08.** WCAG 1.4.3 excludes inactive components; the label still needs
  to be *readable* to know what is missing, hence `#94A3B8` on `#E2E8F0` rather than a
  near-invisible ghost.
- **resting input border — 1.23.** `#E2E8F0` is the hairline the whole system uses. A field is not
  carried by its border — it has a visible label above it and a 2px `#047857` ring (5.48) the moment
  it takes focus, and the invalid state is a 2px `#DC2626` line at 4.83.
- **switch thumb against track, off — 1.13.** The on state clears the 3:1 non-text floor at 5.21. At
  rest the thumb reads from its position on the left and the platform's own thumb shadow, not from
  colour; a darker off thumb would look like the engaged state, which is the worse failure.
- **live/online dot — 2.54.** `#10B981` is the only bright emerald in the system and it is never the
  sole signal: the words "Online" / "Live" sit beside it in a colour that does clear AA. WCAG treats
  a redundant indicator as decoration. It is asserted here so nobody later reads 2.54 as an
  oversight.

---

## 6. Accessibility behaviour

- **Dynamic type.** `allowFontScaling` is on by default and the platform scales `fontSize` itself,
  so `Text` multiplies only `lineHeight` and `letterSpacing` by `useWindowDimensions().fontScale`.
  Scaling the size too would double-apply it on device; leaving the leading in design units clips
  descenders at large settings. `includeFontPadding: false` keeps Android from clipping the display
  sizes.
- **Reduced motion.** `useReducedMotion()` reads `AccessibilityInfo` and subscribes to
  `reduceMotionChanged`; animated surfaces drop to an instant state change when it reports on.
- **Focus and press are visible.** Every control draws a 2px `#047857` ring on keyboard focus, and
  `:focus-visible` is set globally for the web surfaces. Pressed states change colour, not
  elevation.
- **Screen readers.** `Button` exposes `accessibilityState={{disabled, selected, busy}}` and takes an
  optional `accessibilityLabel` override; `Field` labels the input with its own label text and
  announces an error with `accessibilityRole="alert"`; tabs, list rows and states carry roles
  throughout.
- **Touch targets.** `sizing.touchTarget` (44) is the `minHeight` floor for every control, so the
  `sm` button never drops below it.
- **Colour is never the only signal.** Every status is written in words next to its tint, and the
  one sub-AA colour in the system (the live dot) is explicitly redundant rather than load-bearing.
- **Map markers.** Pickup `#047857`, destination `#0F172A` — the two are never the same colour, and
  neither is decorative.

---

## 7. Dark mode: ready, not shipped

No dark theme exists and none is promised. The structure is what makes one a data change rather
than a rewrite: every colour is a **semantic role**, components read `theme.colors.<role>` and never
a hex, `ThemeProvider` takes an optional `theme` prop, and `cssVariables()` re-projects whatever
object it is handed. A dark variant is a second `colors` map plus a scheme check at the two layout
roots. What that swap has *not* been tested against is tinted alphas (`scrim`, `hairline`) and the
elevation presets, both of which assume a light ground — they are the items a dark pass would start
with. `surfaceBrand` (`#0F172A`) already fixes the dark surfaces' value, so a dark theme is an
inversion of `background`/`surface` more than it is a new palette.

---

## 8. What has been seen, and what has not

Rendered and checked in a browser (`npm run mobile:web` → `http://localhost:8081`, emulator behind
it, signed in through the real phone-and-code screen):

- Customer: Book, Trips, trip detail, Saved places, Support, Account — as `+919000000001` with
  seeded data and as `+919000000002` with the empty states. Book is now the reference-design
  composer, and its controls were driven rather than admired: a transmission card and a preference
  chip both took selection (2px brand border), Swap exchanged the ends, and Confirm wrote a real
  booking that was then read back from Firestore carrying `transmission: manual` and
  `notes: "Non-smoking driver"`.
- Book now runs in the order the owner asked for: Book a driver → Local / Hourly / Outstation → your
  car → one way or round trip → pickup → drop-off → the fare with its GST named → Confirm, and Confirm
  navigates to the trip instead of leaving a "request received" card behind. Re-driven on the browser
  after the distance chart landed, on one and the same 32.7 km Sector 56 ↔ Connaught Place drive: one
  way priced **₹744.45** with the duration box reading "By distance" and the expanded lines naming
  "32.7 km charged on the ₹559 slab" plus the flat ₹150 night allowance, Hourly re-priced the same
  drive to **₹576.45** on the `h4` card with the box becoming "4 hours (40 km included)", and the
  "Price rules and what to know" sheet rendered all seven bands with
  "One band prices the whole route. The bands are never added together." Outstation and cab are
  disabled tabs quoting the operator's reason instead of a price. The trip screen states a round trip
  as "the driver comes back with you, so the fare is a package of hours" above the itemised package +
  night + GST lines.
- Layout is measured, not eyeballed. Two defects only a browser finds were fixed this way: a
  document wider than the viewport (703 against 531 CSS px) because flex segments refused to shrink
  below their one-line labels, and the availability panel painting over the Confirm button — both
  confirmed gone by re-reading `document.documentElement.scrollWidth` against `innerWidth` and by
  `elementFromPoint` on the button itself.
- Driver: home, earnings, documents. The Documents screen now leads with **Your dues** — one card per
  stored row, title on the left, a `warning` "to pay" pill or a `success` "paid" pill on the right,
  then three `caption` lines (₹564.40 / GST (5%) ₹28.22 / **₹592.62** in `bodyStrong`) and a `muted`
  caption saying to hand it over at the office. Read back on 2026-10-25 as Rakesh
  (`+919000000011`, signed in through the real code screen): three commission rows headed "Commission
  on trip DRX-9HD4W1 — Trip commission · 15% of the fare · booking bk-demo-4" under a
  "to pay ₹655.50" total, and his cleared fee in the same list as "Collected as cash by the office.
  You do not owe this again." Nothing in that card is computed in the view — every figure is the
  stored due, and the GST label prints the rate off the row rather than a hard-coded 5%.
- The Duty screen quotes the same stored sum in its own sentence, and names the *kinds* rather than
  one blanket phrase, because the office needs to know what it is being handed:
  "₹655.50 is still outstanding — commission on 3 trips. The office records what you hand over, and
  new bookings resume the moment nothing is owed." A driver who owes only the fee reads
  "… — the one-time onboarding fee …", and one who owes both reads "the one-time onboarding fee and
  commission on 2 trips". So the two screens a driver sees cannot disagree.
- Auth: sign-in, sign-up, developer sign-in, and the cold-start route guard.
- All nine tab-group routes — six customer, three driver — at a 375px-wide layout with zero
  horizontal overflow and no truncated tab label, and again at desktop width. Computed styles were
  read back off the live render, not assumed: after the emerald pass the sign-in wordmark measures
  `rgb(15,23,42)` at weight `800` in PlusJakartaSans, the page ground `rgb(248,250,252)`, and the
  primary button `rgb(4,120,87)` behind a `rgb(255,255,255)` label — the 5.48:1 pair asserted in
  §5. All five Jakarta faces report loaded.

Rendered in a browser (`http://localhost:3001`, `npm run admin`): the operations console, including
its status badges — which is how a stale-CSS problem masquerading as "every badge is the same grey"
was found and fixed, and how the emerald header band and the blue `info` badge were confirmed to
stay distinguishable.

Its driver panel now carries the money half of the same decision, and driving it found two defects
that reading the file did not:

- The collected-fee sentence rendered the literal text `{onboardingFee.reference}` — JSX braces
  inside a template string, not an interpolation. It now reads `against “UPI ref 5521 0376”. Do not
  collect it twice.`, in the `ink-muted` caption under the itemised totals, with a `success`
  "collected" pill replacing the `warning` "not collected" one.
- Approve sits disabled with an explanation while the fee is owed ("Approve is held until ₹10.50 is
  recorded as collected. The server refuses the approval too — this only saves you from finding that
  out by pressing it"), and the reference field starts empty so "Money collected" is unreachable
  until the operator types what they were handed. Both were exercised for real, in order: record, then
  approve, then read `· driver id DRV-Q68VJD` in the header as the queue emptied itself.

`/dues` is the console's second money surface and was rendered the same way (2026-10-25): a totals band
(TOTAL TO COLLECT ₹970.50, TRIP COMMISSION (15% OF FARE + 5% GST) ₹655.50, ONBOARDING FEES ₹10.50,
"2 drivers hold an unpaid row") over one card per driver, each due row itemised as
`₹564.40 + 5% GST ₹28.22 = ₹592.62` with its booking reference in the caption, and the driver's whole
bill gathered behind one button — "Record ₹655.50 · 3 charges" — that stays disabled until the receipt
field has text. The `warning`/`success` pill pair is reused from the verification queue, so a cleared
row reads the same in both screens, and the operations-only account sees the list with the record
control replaced by "Read-only for this account: recording a collection needs the administrator
claim." under each card plus, at the foot of the page, "Signed in as ops@drivx.test, which carries the
operations claim only. The list is yours to read; recording a collection is refused by the server,
because the audit entry has to name an administrator." The totals band is byte-identical between the
two accounts, so the read path really is shared and only the write path differs. Two rules the design
did not imply: the page is a `collectionGroup` read, so it renders empty
rather than erroring if the staff-only list grant is missing, and one tap on "Record ₹655.50 · 3
charges" is three separate `recordDriverDuePayment` calls — one per row, one audit entry per row —
because the server refuses a second collection of a fee it has already recorded. That is what stops a
trip cleared last week from being billed again today; the button only looks like a bulk edit.

Every ₹ figure quoted above is that run's, on the fare chart and the 15% cut of that day. The cut
is now the office's configurable one — 13% by default — so on today's seed the same two screens read
"Commission on trip DRX-9HD4W1 — 13% of ₹1,672.00 fare", ₹54.46 / ₹54.46 / ₹228.23 and a "to pay
₹337.15" total, ₹652.15 in the console band, whose heading prints "TRIP COMMISSION (13% OF FARE + 5%
GST)". That heading and the empty live ledger were re-rendered on 2026-10-27; the populated screens
have not been re-rendered since the rate moved, because both apps now point at `drivx-116de` and its
trip ledger has no rows yet. Every one of those numbers arrives at the page the same way as before:
read off the stored row, with the percentage printed off `row.rate`.

**Automation caveat worth knowing.** In this Next app, a harness that sets `input.value` directly
leaves React's own state empty, so pressing the button appears to do nothing at all — no request, no
error. Driving a field means the native value setter plus a dispatched `input` event (and `change`
for a `<select>`), and a `type="submit"` button needs `form.requestSubmit()` rather than a synthetic
click. That is a harness limitation, not an app bug — a real keyboard does the right thing.

**Not** rendered: anything on a physical phone or tablet. No iOS or Android build has been run, so
platform-specific font rendering, the iOS large-text picker, Android's `includeFontPadding`
behaviour and real VoiceOver/TalkBack announcements are unverified.

**Known a11y gap on the web build only.** `OptionCard` and `Chip` pass
`accessibilityState={{ selected, checked }}`, which react-native-native honours but this
react-native-web version silently drops — `createDOMProps` there reads `aria-checked` /
`aria-selected` props that React Native's `Pressable` type does not declare. The web render
therefore announces three `role="radio"` elements with no checked state, while the selected one is
visually obvious (2px emerald border, white ground, filled dot). Native builds are unaffected;
fixing the web case means passing ARIA attributes the shared type rejects, so it is left as a
recorded limitation rather than solved with a cast.

**Not invented:** at the time of the design pass the brief listed surfaces this repository did not
have yet — splash/onboarding UI, Places autocomplete, map pin picking, scheduling, a fare-estimate
screen, cancellation flows, ratings, a notifications screen, live tracking, driver trip flows, and
admin tables, filters and metrics. They were deliberately absent rather than stubbed with mock data.
Several have since been built — Places autocomplete, scheduling, the server-priced fare card, the
notifications list and, from the customer's end only, cancellation — so the README status board, not
this list, is the authority on what a screen does today.
The theme pass itself changed no business logic, Firebase integration, route or data shape; the
booking composer rewrite that followed it did touch them — it surfaces a thrown callable failure in
the fare card instead of leaving the tap silent, and `functions/src/lib/admin.ts` sets
`ignoreUndefinedProperties` so a place with no second address line can be booked at all.
