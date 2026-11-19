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
5. **↻ Restart app** (top bar) stops every toy, syncs with your other device (if Sync devices is on), loads the newest version of ToyDeck and reloads. Your saved toys reconnect by themselves; no need to close and reopen the app after an update.

## Each toy card
Toys you've added before open **minimized**: just the toy's picture, name and status. **Tap the card to open
its controls**, and tap the top of the card (picture and name) to minimize it again. A minimized toy that's
playing shows a green **Running** tag; **STOP ALL** still stops it. A toy you've just added opens full size.

Pictures are matched by the toy's Bluetooth name (currently Faunus, Flamewing, Petalwish, Phantom, Pinhead, Punch, Rhythmic3, Rosella, Royaleye, Viele and VividWings) and are stored inside the app, so they work offline; other toys show the ToyDeck icon.

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
- **Controls this toy has:** tick what the toy can do: **Heat**, **Suction levels**, **Lights**, **Squeeze**, **Ripple**, **Squirt**. Each one ticked gets an On/Off button (Suction: level buttons) on the card and a row in the All toys panel. **Suction levels** sets how many level buttons appear (try lower if top levels feel the same).
  *Suction comes two ways. Some toys take suction **levels** (tick Suction levels). Others drive suction like a motor: give the toy a motor with Type **Suction** instead. **J-Rosella 2** is the second kind: Motors 1, Type Suction, Channel 1.*
  *Ripple is JoyHub's separate wiggle/ripple switch. If one of the toy's motors is what wiggles, set that motor's Type to Wiggle instead.*
- **Motors:** how many motors the toy has, **0 to 4**. Choose **0** for a toy with no motors (e.g. suction only): its card then shows just its other controls, and it never gets motor commands.
- **Motor type:** **Vibe**, **Thrust**, **Wiggle**, **Flipper** or **Suction** for each motor. Sliders are coloured by type: Vibe green, Thrust orange, Wiggle purple, Flipper cyan, Suction pink. A one-motor flipper toy: Motors 1, Type Flipper. Its slider is named after it, and the All toys panel uses it (below).
- **Motor channel:** which of the toy's 4 command positions each motor uses. If a motor slider does nothing, try another channel.
  *J-VividWings: 2 motors on channels 1 and 3.*
- **Minimum power:** raise it if the toy doesn't move at low slider levels.
- **Forget this toy:** removes it and its recordings (tap twice).
- The grey line at the bottom shows what's being sent and received, which helps if something doesn't work.

## All toys panel
**On / Off** (next to STOP ALL): **Off** means this panel has no effect on any toy: no Override, no master level, no function switches, no Play on all. Every toy runs on its own settings. STOP ALL, Edit patterns, Sync devices, Back up and Restore still work. Remembered on this device.

Opens **minimized**, like the toy cards: tap **All toys** to open its controls, tap it again to minimize. **STOP ALL** sits at the top right of this panel and **always shows**, minimized or not. It also switches off heat, suction and every extra. If the master level is below 100%, the minimized panel shows an orange **Master 60%** tag.
- **Turn on by function:** one row per function your toys have, each with its own On/Off: motors (**Vibe 1**, **Vibe 2**, … **Thrust**, **Wiggle**, **Flipper**, **Suction**, with a level slider), **Heat**, **Lights**, **Squeeze**, **Ripple**, **Squirt**, and **Suction levels** (Off / level buttons).
  - Motor rows are numbered when any toy has more than one of that kind: **Vibe 1** = every toy's first vibe motor, **Vibe 2** = every toy's second, matching the names on the toy cards.
  - **On** sets that function on every *connected* toy that has it to the row's level and starts it. A stopped toy starts with only that function; its other motors stay off.
  - **Off** turns that function off on every toy. A toy playing a **pattern** stops completely, because a pattern drives all its motors together.
  - **Override** (one button, at the top of the list) covers every motor on every toy. **On**: the row sliders set the levels, over the toys' own sliders; toy sliders show "All toys 80%" and are locked.
    **Off** (the default): each toy uses its own sliders (set them on each toy) and the row sliders hide. Your own levels come back exactly as you left them.
  - Moving a row's slider switches it on, like a toy's own slider. Override is remembered on this device.
  - Toys that aren't connected are never changed, so nothing starts by surprise when one connects.
- **Master level:** scales every toy at once.
- **Pattern for all → Play on all:** starts the chosen pattern on every toy. Choose **Manual (no pattern)** and tap **Set all to Manual** to put every toy back on its sliders (stopped), so you drive them yourself. **Sync** restarts all patterns together.
- **Edit patterns:** draw your own patterns (drag across the bars). They're shared by all toys.
- **Connect saved toys:** reconnects every remembered toy it can.
- **Sync devices:** keeps your phone and PC the same automatically: toys and their setup, drawn patterns and recordings.
  It goes through your own **private** GitHub repo (`toydeck-sync`). A change on one device shows on the other within
  about 30 seconds (or straight away when you switch back to the app). A green dot on the button means sync is
  working, a red one means it isn't (open it to see why).
  - **Set up, once per device:** tap **Sync devices**, check the repo (`yourname/toydeck-sync`), paste your access
    token, tap **Save and sync**. GitHub shows a token only once, so the easy way is one token per device, made on
    that device (the same token on every device works too). It's kept only on that device.
  - **Getting the token (once):** github.com → Settings → Developer settings → Personal access tokens → Fine-grained
    tokens → Generate new token. Repository access: *Only select repositories* → `toydeck-sync`.
    Permissions: *Contents* → *Read and write*. If it expires, make a new one and paste it on each device.
  - **What doesn't sync:** anything about what a toy is doing right now (running, mode, levels of a connected toy,
    heat/suction/extras), plus Override and the panel's On/Off. Nothing from the other device changes a running toy; if
    you change a running toy's motors on the other device, it stops here and asks you to press Start.
  - Forgetting a toy on one device forgets it on the other too (unless it's connected there).
  - **Turn off on this device** stops syncing but keeps everything that's already here.
- **Back up / Restore:** saves your toys, patterns and recordings to a file and loads them on another device.

## On a phone
- The screen stays on while toys are connected.
- If you switch apps or lock the phone, ToyDeck **stops the toys** (Android pauses the app, and a toy would otherwise keep running with nothing to stop it). Tap **Start** when you're back.

## Privacy
Everything stays on your device, unless you turn on **Sync devices**: then your toys' setup, patterns and recordings are also kept in your own private GitHub repo, and nowhere else. There are no ToyDeck accounts, no ToyDeck servers and no tracking. This site is just the app's files.
