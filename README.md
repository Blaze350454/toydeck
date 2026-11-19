# ToyDeck

Control several JoyHub-protocol Bluetooth toys at once from your phone or PC: per-motor sliders with
On/Off, Start/Stop, patterns you draw or record live, heat and suction, battery level, and one big STOP.

**Open it:** https://blaze350454.github.io/toydeck/ in **Chrome** (Android, Windows, Mac, ChromeOS).
Web Bluetooth doesn't work in Safari/iPhone or Firefox.

## Install it like an app
- **Android:** open the link in Chrome → **Install app** at the top, or ⋮ menu → *Install app* / *Add to Home screen*.
- **PC:** open the link in Chrome → **Install app** (or the install icon in the address bar). It gets its own window and Start-menu entry.
- Updates arrive automatically the next time you open it with internet. It also opens offline.

## Quick start
1. Switch your toy on and tap **+ Add toy**, then pick it from Chrome's list. Repeat for each toy.
2. Open **Toy settings** on the card the first time and set it up (see below).
3. Choose **Manual** or **Pattern**, then tap the green **Start**. Tap the red **Stop** to pause.
4. **STOP ALL** (or the **Space** key on a PC) stops every toy: motors, suction and heat.
5. **↻ Restart app** (top bar) stops every toy, loads the newest version of ToyDeck and reloads. Your saved toys reconnect by themselves; no need to close and reopen the app after an update.

## Each toy card
Toys you've added before open **minimized**: just the toy's picture, name and status. **Tap the card to open
its controls**, and tap the top of the card (picture and name) to minimize it again. A minimized toy that's
playing shows a green **Running** tag; **STOP ALL** still stops it. A toy you've just added opens full size.

Pictures are matched by the toy's Bluetooth name (currently **J-Phantom** and **J-Pinhead**) and are stored inside the app, so they work offline; other toys show the ToyDeck icon.

The **J-** that every JoyHub toy name starts with is left off on screen (J-Phantom shows as **Phantom**). Chrome's own Bluetooth list still shows the full name.

| Control | What it does |
|---|---|
| **Manual / Pattern** | Choose how the toy is driven. Switching always starts **stopped**. |
| **Start / Stop** | The main switch for that toy. Stop keeps everything where it was; Start carries on. |
| **Motor sliders + On/Off** | Strength for each motor. On/Off mutes a motor without losing its slider position. Moving a slider switches that motor On. |
| **Same level for all motors** | One slider (and one On/Off) for every motor. |
| **● Record pattern** | Records your slider moves live (each motor separately) until you tap **■ Stop recording**, then name and **Save** it. Recordings belong to that toy and appear in its Pattern list marked **●**. Recording starts the toy for you. |
| **Pattern** list | Built-in patterns, your drawn patterns (★) and this toy's recordings (●). **Delete recording** removes a recording (tap twice). |
| **Strength + On/Off** | How strong the pattern plays. Off = toy goes quiet while the pattern keeps its place. |
| **Speed + On/Off** | How fast the pattern plays. Off = the pattern freezes on its current step and holds it. |
| **Offset motors** | On multi-motor toys, the motors take turns instead of moving together. |
| **Heat** | On/Off (only shown if you tick Heat in Toy settings). |
| **Suction** | Off / 1 / 2 / 3 … levels (only shown if you tick Suction in Toy settings). |
| **Battery 73%** | Next to the name, if the toy reports battery. Turns red below 20%. |
| **Connect / Disconnect** | Toys you've added are remembered and show up as cards; Connect brings one back in one tap. |

## Toy settings (per toy, remembered)
- **Controls this toy has:** tick **Heat** and/or **Suction**. **Suction levels** sets how many level buttons appear (try lower if top levels feel the same).
- **Motors:** how many motors the toy has.
- **Motor type:** **Vibe** or **Thrust** for each motor. Its slider is named after it, and the All toys panel uses it (below).
- **Motor channel:** which of the toy's 4 command positions each motor uses. If a motor slider does nothing, try another channel.
  *J-VividWings: 2 motors on channels 1 and 3.*
- **Minimum power:** raise it if the toy doesn't move at low slider levels.
- **Other extras:** Lights, Squeeze, Wiggle, Squirt switches for toys that have them.
- **Forget this toy:** removes it and its recordings (tap twice).
- The grey line at the bottom shows what's being sent and received, which helps if something doesn't work.

## All toys panel
Opens **minimized**, like the toy cards: tap **All toys** to open its controls, tap it again to minimize. **STOP ALL** sits at the top right of this panel and **always shows**, minimized or not. If the master level is below 100%, the minimized panel shows an orange **Master 60%** tag.
- **Turn on by function:** one row per function your toys have: **Vibe**, **Thrust** (On/Off + level), **Heat** (On/Off), **Suction** (Off / levels).
  - **On** sets that function on every *connected* toy that has it to the row's level and starts it. A stopped toy starts with only that function; its other motors stay off.
  - **Off** turns that function off on every toy. A toy playing a **pattern** stops completely, because a pattern drives all its motors together.
  - Moving a row's slider changes the level on every toy (and switches it on, like a toy's own slider).
  - Toys that aren't connected are never changed, so nothing starts by surprise when one connects.
- **Master level:** scales every toy at once.
- **Pattern for all → Play on all:** starts the chosen pattern on every toy. **Sync** restarts all patterns together.
- **Edit patterns:** draw your own patterns (drag across the bars). They're shared by all toys.
- **Connect saved toys:** reconnects every remembered toy it can.
- **Back up / Restore:** saves your toys, patterns and recordings to a file and loads them on another device. Settings are stored separately on each device, so use this to keep your phone and PC matching.

## On a phone
- The screen stays on while toys are connected.
- If you switch apps or lock the phone, ToyDeck **stops the toys** (Android pauses the app, and a toy would otherwise keep running with nothing to stop it). Tap **Start** when you're back.

## Privacy
Everything stays on your device. There are no accounts, no servers and no tracking. This site is just the app's files.
