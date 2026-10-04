# Pal map navigation and encounter periods

Pal-dex field data offers separate **Show on map** and **Show Alpha locations** links when the manifest contains the corresponding exterior encounters. The map searches both ordinary wild species and species with only a fixed Alpha location. The encounter selector supports wild, Alpha, or both.

A cross-link retains the current map when that encounter type has locations there; otherwise it opens Palpagos or the World Tree according to the actual locations. The viewport fits those locations after the correct map image has loaded. A single Alpha is centred. Opening a profile link resets the period to **All times**, so a previously selected day filter cannot hide its nocturnal target.

The **All times / Day / Night** selector persists locally. Night-only encounters are excluded during Day; unrestricted encounters remain visible during both periods. This is an encounter schedule filter, not the server's current clock or a live respawn indicator. Unknown Alpha schedules remain visible.

A fixed Alpha's schedule is joined to its own spawn entry using map, encounter ID, coordinates (allowing the manifest's one-centimetre rounding), and level. A random or dungeon Alpha elsewhere does not supply a fixed boss's schedule. Lyleen Noct and Splatterina consequently appear at night, while bosses without a known restriction remain available in both filters.

`app/src/lib/map-spawns.test.ts` checks map selection, Alpha-only species, exact schedule joins, period filtering, viewport fitting and representative routes in the published manifest. Browser verification in the companion additionally checks profile navigation, map image loading, Alpha centring, French controls, persistence and material map links.
