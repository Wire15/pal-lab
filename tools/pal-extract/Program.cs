using System.Text.RegularExpressions;
using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Core.i18N;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json;
using SkiaSharp;

namespace PalExtract;

static class Program
{
    // Known build of the installed Palworld (per project constraints / build 24181527).
    const string GameBuild = "24181527";
    const string UsmapSource = "PalworldModding/UsefulFiles@1.0";

    static readonly string PaksDir = Environment.GetEnvironmentVariable("PALCALC_PALWORLD_PAKS")
        ?? @"C:\Program Files (x86)\Steam\steamapps\common\Palworld\Pal\Content\Paks";
    static readonly string UsmapPath = Environment.GetEnvironmentVariable("PALCALC_MAPPINGS_USMAP")
        ?? Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "Mappings.usmap");
    static readonly string OutDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));

    // T_Icon_element sprite index -> element kind (canonical order, cf. palcalc BuildDBProgram.ExportElementIcons)
    static readonly string[] IconKinds = { "Normal", "Fire", "Water", "Electricity", "Leaf", "Dark", "Dragon", "Earth", "Ice" };

    static readonly Regex Ws = new(@"[ \t]+");
    static readonly Regex RichTag = new(@"<[^>]+>");
    // <itemName id=|Wool| style=|X|/>, <characterName id=|Anubis|/>, <img id=|ElemIcon_Ice|/>, ...
    static readonly Regex IdTag = new(@"<(\w+)\s+id=\|([^|]+)\|[^>]*?/?>");

    static int Main(string[] args)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        OodleHelper.DownloadOodleDll();
        OodleHelper.Initialize();

        var provider = new DefaultFileProvider(PaksDir, SearchOption.AllDirectories, true, new VersionContainer(EGame.GAME_UE5_1));
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(Path.GetFullPath(UsmapPath));
        provider.Initialize();
        provider.Mount();
        provider.LoadVirtualPaths();
        Console.WriteLine($"[mount] files={provider.Files.Count} ({sw.Elapsed.TotalSeconds:F1}s)");

        if (args.Contains("--discover")) { Discover(provider); return 0; }
        if (args.Contains("--discover-learnset")) { DiscoverLearnset(provider); return 0; }
        if (args.Contains("--discover-breeding")) { DiscoverBreeding(provider); return 0; }

        var monsters = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalMonsterParameter");
        var skillNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_SkillNameText_Common");
        var skillDescs = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_SkillDescText_Common");
        var palNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_PalNameText_Common");
        var firstActRaw = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_PalFirstActivatedInfoText");
        var itemNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_ItemNameText_Common");
        var mapObjNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_MapObjectNameText_Common");
        var uiCommon = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_UI_Common_Text_Common");
        var passiveMain = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/PassiveSkill/DT_PassiveSkill_Main");
        // partner-skill template resolution sources (see ResolvePartnerTemplates):
        var partnerParam = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/PassiveSkill/DT_PartnerSkillParameter");
        var partnerParamByName = new Dictionary<string, FStructFallback>(StringComparer.OrdinalIgnoreCase);
        foreach (var pr in partnerParam.RowMap) partnerParamByName[pr.Key.Text] = pr.Value;
        var passiveRowByName = new Dictionary<string, FStructFallback>(StringComparer.OrdinalIgnoreCase);
        foreach (var pr in passiveMain.RowMap) passiveRowByName[pr.Key.Text] = pr.Value;
        var partnerAppend = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_PartnerSkillAppendText");
        var partnerTemplateMiss = new SortedSet<string>(StringComparer.Ordinal);
        var partnerTemplateFam = new SortedDictionary<string, int>(StringComparer.Ordinal);
        int partnerTemplatedDescs = 0, partnerTemplatedDescsClean = 0;
        int partnerTemplatesEmitted = 0, partnerTemplateSlotTotal = 0;
        var iconTab = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/PartnerSkill/DT_partnerSkillIconDataTable");
        var iconTexField = iconTab.RowMap.First().Value.Properties.First(p => p.Name.Text.StartsWith("TextureID")).Name.Text;
        var iconInfo = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var ir in iconTab.RowMap) iconInfo[ir.Key.Text] = ir.Value.Get<int?>(iconTexField) ?? -1;
        Console.WriteLine($"[tables] monsters={monsters.RowMap.Count} skillNames={skillNames.Count} skillDescs={skillDescs.Count} firstAct={firstActRaw.Count} icons={iconInfo.Count} passiveRows={passiveMain.RowMap.Count}");

        if (args.Contains("--export-named-partner-icons"))
        { ExportNamedPartnerIcons(provider, iconInfo); return 0; }

        var species = new SortedDictionary<string, object>(StringComparer.Ordinal);
        int kept = 0, skipped = 0;
        int partnerHit = 0;
        var partnerMisses = new List<string>();
        int partnerDescHit = 0; var partnerDescMiss = new List<string>();
        var partnerIconIds = new SortedSet<int>(); var partnerIconMiss = new List<string>();
        var elementKinds = new SortedSet<string>(StringComparer.Ordinal);
        // internalName -> english display, for validation only
        var displayByInternal = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in palNames)
            if (kv.Key.StartsWith("PAL_NAME_", StringComparison.OrdinalIgnoreCase))
                displayByInternal[kv.Key.Substring("PAL_NAME_".Length)] = kv.Value;

        foreach (var r in monsters.RowMap)
        {
            var name = r.Key.Text;
            var v = Vals(r.Value);
            bool playable = B(v, "IsPal") && !(B(v, "IsBoss") || B(v, "IsTowerBoss") || B(v, "IsRaidBoss"))
                && !name.StartsWith("SUMMON_", StringComparison.OrdinalIgnoreCase)
                && !name.StartsWith("BOSS_", StringComparison.OrdinalIgnoreCase)
                && !name.StartsWith("GYM_", StringComparison.OrdinalIgnoreCase)
                && !name.StartsWith("RAID_", StringComparison.OrdinalIgnoreCase)
                && !name.Contains("PREDATOR", StringComparison.OrdinalIgnoreCase)
                && !name.EndsWith("_Oilrig", StringComparison.OrdinalIgnoreCase)
                && !name.Contains("Quest", StringComparison.OrdinalIgnoreCase)
                && I(v, "Rarity") > 0 && I(v, "WalkSpeed") > 0 && I(v, "RunSpeed") > 0;
            if (!playable) { skipped++; continue; }
            kept++;

            var elements = new List<string>();
            foreach (var ek in new[] { "ElementType1", "ElementType2" })
            {
                var e = StripEnum(S(v, ek));
                if (!string.IsNullOrEmpty(e) && e != "None") { elements.Add(e); elementKinds.Add(e); }
            }

            // partner skill: name from skillNames (variant-aware); description from the in-game "first activated" info text; icon from icon table
            var nameKey = ResolvePartnerKey(skillNames, NonNone(S(v, "OverridePartnerSkillNameTextID")), name);
            object partner = null;
            if (nameKey != null && skillNames.TryGetValue(nameKey, out var pName))
            {
                partnerHit++;
                var descKey = ResolveVariantKey(k => firstActRaw.ContainsKey(k), "PAL_FIRST_SPAWN_DESC_", name)
                    ?? (name.Contains('_') ? ResolveVariantKey(k => firstActRaw.ContainsKey(k), "PAL_FIRST_SPAWN_DESC_", name.Substring(name.IndexOf('_') + 1)) : null);
                // per-rank template data lives in DT_PartnerSkillParameter, keyed by species internal name.
                // Element-swap variants (e.g. ElecSnail_Fire) carry a STUB param row with no template data
                // and inherit the base pal's partner skill, so skip data-less rows and fall back to the base.
                var paramKey = ResolveVariantKey(k => partnerParamByName.ContainsKey(k) && HasTemplateData(partnerParamByName[k]), "", name);
                var paramRow = paramKey != null ? partnerParamByName[paramKey] : null;
                bool hadTemplate = descKey != null && firstActRaw[descKey].Contains('{');
                var descMiss = new SortedSet<string>(StringComparer.Ordinal);
                string pTemplate = null; List<List<string>> pTemplateValues = null;
                string pDesc = descKey != null ? CleanPartnerDesc(firstActRaw[descKey], palNames, itemNames, mapObjNames, uiCommon,
                    skillNames, paramRow, passiveRowByName, partnerAppend, descMiss, partnerTemplateFam,
                    out pTemplate, out pTemplateValues) : null;
                if (pDesc != null) partnerDescHit++; else partnerDescMiss.Add(name);
                if (hadTemplate)
                {
                    partnerTemplatedDescs++;
                    if (descMiss.Count == 0) partnerTemplatedDescsClean++;
                    foreach (var t in descMiss) partnerTemplateMiss.Add($"{name}:{t}");
                }
                var iconKey = ResolveVariantKey(k => iconInfo.ContainsKey(k), "", name);
                string icon = null;
                if (iconKey != null && iconInfo[iconKey] >= 0) { icon = iconInfo[iconKey].ToString(); partnerIconIds.Add(iconInfo[iconKey]); }
                else partnerIconMiss.Add(name);
                partner = new { name = Clean(pName), description = pDesc, icon, template = pTemplate, values = pTemplateValues };
                if (pTemplate != null) { partnerTemplatesEmitted++; partnerTemplateSlotTotal += pTemplateValues.Count; }
            }
            else partnerMisses.Add(name);

            var stats = new
            {
                price = (long)Math.Round(F(v, "Price")),
                craft_speed = I(v, "CraftSpeed"),
                slow_walk_speed = I(v, "SlowWalkSpeed"),
                walk_speed = I(v, "WalkSpeed"),
                run_speed = I(v, "RunSpeed"),
                ride_sprint_speed = I(v, "RideSprintSpeed"),
                transport_speed = I(v, "TransportSpeed"),
                stamina = I(v, "Stamina"),
                size = StripEnum(S(v, "Size")),
                food_amount = I(v, "FoodAmount"),
                max_full_stomach = I(v, "MaxFullStomach"),
                rarity = I(v, "Rarity"),
                male_probability = I(v, "MaleProbability"),
                combi_rank = I(v, "CombiRank"),
                nocturnal = B(v, "Nocturnal"),
            };

            species[name] = new { elements, partner_skill = partner, stats };
        }
        Console.WriteLine($"[species] kept={kept} skipped={skipped} partnerCoverage={partnerHit}/{kept}");
        Console.WriteLine($"[elements] distinct=[{string.Join(",", elementKinds)}]");
        if (partnerMisses.Count > 0)
            Console.WriteLine($"[partner misses {partnerMisses.Count}] {string.Join(" | ", partnerMisses)}");
        Console.WriteLine($"[partner-desc] hit={partnerDescHit}/{kept} miss={partnerDescMiss.Count}");
        if (partnerDescMiss.Count > 0) Console.WriteLine($"[partner-desc misses] {string.Join(" | ", partnerDescMiss)}");
        Console.WriteLine($"[partner-templates] templatedDescs={partnerTemplatedDescs} fullyResolved={partnerTemplatedDescsClean} unresolved={partnerTemplateMiss.Count}");
        Console.WriteLine($"[partner-templates by family] {string.Join(", ", partnerTemplateFam.Select(kv => $"{kv.Key}={kv.Value}"))}");
        Console.WriteLine($"[partner-per-level] speciesWithTemplate={partnerTemplatesEmitted} totalSlots={partnerTemplateSlotTotal}");
        if (partnerTemplateMiss.Count > 0) Console.WriteLine($"[partner-template UNRESOLVED] {string.Join(" | ", partnerTemplateMiss)}");
        if (partnerIconMiss.Count > 0) Console.WriteLine($"[partner-icon species w/o icon-table row {partnerIconMiss.Count}] {string.Join(" | ", partnerIconMiss)}");

        // ---- passives ----
        var passives = new SortedDictionary<string, object>(StringComparer.Ordinal);
        int passKept = 0, passFilteredNoName = 0, passFilteredStub = 0;
        int passAddPal = 0, passPalAny = 0, passPlayer = 0, passWorld = 0, passMut = 0;
        var worldMembers = new List<string>();
        var mutMembers = new List<string>();
        var allPassiveFields = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var r in passiveMain.RowMap)
        {
            var row = r.Key.Text;
            var pv = Vals(r.Value);
            foreach (var pf in r.Value.Properties) allPassiveFields.Add(pf.Name.Text);
            var pNameKey = NonNone(S(pv, "OverrideNameTextID")) ?? "PASSIVE_" + row;
            if (!skillNames.TryGetValue(pNameKey, out var pname)) { passFilteredNoName++; continue; }
            pname = Clean(pname);
            if (string.IsNullOrEmpty(pname) || pname == "en Text" || pname == "-") { passFilteredStub++; continue; }

            var effects = new List<object>();
            for (int i = 1; i <= 4; i++)
            {
                var et = StripEnum(S(pv, "EffectType" + i));
                if (string.IsNullOrEmpty(et) || et == "no" || et == "None") continue;
                effects.Add(new { type = et, value = IntOrRound(F(pv, "EffectValue" + i)), target = StripEnum(S(pv, "TargetType" + i)) });
            }
            bool addPal = B(pv, "AddPal"), addRare = B(pv, "AddRarePal"), addWorld = B(pv, "AddWorldTreePal"), addMut = B(pv, "AddMutationPal");
            bool isPal = addPal || addRare || addWorld || addMut;
            bool isPlayer = B(pv, "AddShotWeapon") || B(pv, "AddMeleeWeapon") || B(pv, "AddArmor") || B(pv, "AddAccessory");

            var descKey = NonNone(S(pv, "OverrideDescMsgID")) ?? "PASSIVE_" + row + "_DESC";
            string desc = null;
            if (skillDescs.TryGetValue(descKey, out var rawDesc) && !string.IsNullOrWhiteSpace(rawDesc) && rawDesc != "-")
                desc = CleanPassiveDesc(rawDesc, pv);

            passives[row] = new
            {
                name = pname,
                rank = I(pv, "Rank"),
                is_pal = isPal,
                is_player = isPlayer,
                world_tree_pool = addWorld,
                mutation_pool = addMut,
                category = StripEnum(S(pv, "Category")),
                effects,
                description = desc,
                lottery_weight = I(pv, "LotteryWeight"),
            };
            passKept++;
            if (addPal) passAddPal++;
            if (isPal) passPalAny++;
            if (isPlayer) passPlayer++;
            if (addWorld) { passWorld++; worldMembers.Add(row); }
            if (addMut) { passMut++; mutMembers.Add(row); }
        }
        Console.WriteLine($"[passives] kept={passKept} filteredNoName={passFilteredNoName} filteredStub={passFilteredStub} isPal(AddPal)={passAddPal} isPal(anyPool)={passPalAny} isPlayer={passPlayer}");
        Console.WriteLine($"[passive-pools] worldTree={passWorld} mutation={passMut}");
        Console.WriteLine($"[passive-pools worldTree ids] {string.Join(", ", worldMembers)}");
        Console.WriteLine($"[passive-pools mutation ids] {string.Join(", ", mutMembers)}");
        Console.WriteLine($"[passive-fields] {string.Join(", ", allPassiveFields)}");

        // ---- breeding boosts (TYPED extraction; see PartnerBreedingBoosts / BreedEffect) ----
        // Discovered by effect key, never by species name, so future breeding pals are caught.
        var breedingBoosts = new List<object>();
        var partnerRefRows = PartnerReferencedPassiveRows(partnerParam);
        int breedPartner = 0, breedPassive = 0;
        // (a) partner-skill boosts per playable species (same variant->param resolution as the
        //     desc/template path). partner_base vs partner_party from the effect's TargetType.
        foreach (var name in species.Keys)
        {
            var paramKey = ResolveVariantKey(k => partnerParamByName.ContainsKey(k) && HasTemplateData(partnerParamByName[k]), "", name);
            if (paramKey == null) continue;
            foreach (var (effect, target, vals) in PartnerBreedingBoosts(partnerParamByName[paramKey], passiveRowByName))
            {
                if (vals.Count == 0) continue;
                var kind = target == "ToBuildObject" ? "partner_base" : "partner_party";
                breedingBoosts.Add(new { source = name, source_kind = kind, effect, values_per_rank = vals });
                breedPartner++;
            }
        }
        // (b) standalone passive boosts (e.g. Babysitter): every EMITTED passive whose row carries
        //     a breeding effect, excluding partner-internal component rows. Flat value -> [frac].
        foreach (var r in passiveMain.RowMap)
        {
            var rowKey = r.Key.Text;
            if (partnerRefRows.Contains(rowKey) || !passives.ContainsKey(rowKey)) continue;
            var pv = Vals(r.Value);
            for (int i = 1; i <= 4; i++)
            {
                var effect = BreedEffect(StripEnum(S(pv, "EffectType" + i)));
                if (effect == null) continue;
                breedingBoosts.Add(new { source = rowKey, source_kind = "passive", effect, values_per_rank = new List<double> { F(pv, "EffectValue" + i) / 100.0 } });
                breedPassive++;
            }
        }
        breedingBoosts = breedingBoosts
            .OrderBy(b => (string)GetProp(b, "source_kind"), StringComparer.Ordinal)
            .ThenBy(b => (string)GetProp(b, "source"), StringComparer.Ordinal)
            .ThenBy(b => (string)GetProp(b, "effect"), StringComparer.Ordinal)
            .ToList();
        Console.WriteLine($"[breeding-boosts] total={breedingBoosts.Count} partner={breedPartner} passive={breedPassive}");
        foreach (var b in breedingBoosts)
            Console.WriteLine($"    {GetProp(b, "source_kind")} {GetProp(b, "source"),-22} {GetProp(b, "effect"),-18} = [{string.Join(", ", ((List<double>)GetProp(b, "values_per_rank")).Select(FmtNum))}]");

        // ---- partner-skill icons ----
        var (iconExported, iconUnresolved) = ExportPartnerIcons(provider, partnerIconIds);
        Console.WriteLine($"[partner-icons] distinctUsed={partnerIconIds.Count} exportedPng={iconExported} unresolvedTextureIds={iconUnresolved.Count}");
        if (iconUnresolved.Count > 0) Console.WriteLine($"[partner-icons unresolved ids] {string.Join(",", iconUnresolved)}");

        // ---- game settings CDO ----
        var gameSettings = ReadGameSettings(provider);

        // ---- element icons ----
        var iconVariants = ExportElementIcons(provider);

        // ---- active skills (waza) ----
        // The active-skill (waza) data table keys each row generically (NewRow_N);
        // the save-side id lives in the row's `WazaType` enum (EPalWazaID::<id>).
        // We emit one entry per resolvable-named waza row with element/power/cooldown/
        // description, plus a name-only fallback for any ACTION_SKILL_<id> localized
        // name that has no waza row (preserves the old active_names coverage set).
        var waza = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Waza/DT_WazaDataTable");
        var activeSkills = new SortedDictionary<string, object>(StringComparer.Ordinal);
        var activeElementKinds = new SortedSet<string>(StringComparer.Ordinal);
        int wazaNoName = 0, wazaDupe = 0;
        bool IsStub(string s) => string.IsNullOrEmpty(s) || s == "en Text" || s == "-";
        string ActiveName(string id) => skillNames.TryGetValue("ACTION_SKILL_" + id, out var n) ? Clean(n) : null;
        string ActiveDesc(string id)
        {
            if (!skillDescs.TryGetValue("ACTION_SKILL_" + id, out var raw)) return null;
            var cleaned = CleanActiveDesc(raw, palNames, itemNames, mapObjNames, uiCommon, skillNames);
            return IsStub(cleaned) ? null : cleaned;
        }
        foreach (var r in waza.RowMap)
        {
            var v = Vals(r.Value);
            var id = StripEnum(S(v, "WazaType"));
            if (string.IsNullOrEmpty(id) || id == "None") continue;
            var nm = ActiveName(id);
            if (IsStub(nm)) { wazaNoName++; continue; }
            if (activeSkills.ContainsKey(id)) { wazaDupe++; continue; }
            var element = StripEnum(S(v, "Element")) ?? "None";
            activeElementKinds.Add(element);
            int power = I(v, "Power");
            int cool = (int)Math.Round(F(v, "CoolTime"));
            activeSkills[id] = new
            {
                name = nm,
                element,
                power = power > 0 ? (int?)power : null,
                cool_time = cool > 0 ? (int?)cool : null,
                description = ActiveDesc(id),
            };
        }
        int wazaBacked = activeSkills.Count;
        // Waza-backed keys use the save-side WazaType enum casing (canonical). The
        // localization table's ACTION_SKILL_<id> suffixes occasionally differ only in
        // case (e.g. WazaType "Railbolt" vs text key "RailBolt"); match case-insensitively
        // so we don't emit a stats-less duplicate under the localization casing.
        var wazaKeyCI = new HashSet<string>(activeSkills.Keys, StringComparer.OrdinalIgnoreCase);
        // Name-only fallback: every ACTION_SKILL_<id> name lacking a waza row.
        var oldNameIds = new List<string>();
        foreach (var kv in skillNames)
        {
            if (!kv.Key.StartsWith("ACTION_SKILL_", StringComparison.OrdinalIgnoreCase)) continue;
            var id = kv.Key.Substring("ACTION_SKILL_".Length);
            if (IsStub(Clean(kv.Value))) continue;
            oldNameIds.Add(id);
            if (wazaKeyCI.Contains(id)) continue;
            wazaKeyCI.Add(id);
            activeElementKinds.Add("None");
            activeSkills[id] = new
            {
                name = Clean(kv.Value),
                element = "None",
                power = (int?)null,
                cool_time = (int?)null,
                description = ActiveDesc(id),
            };
        }
        // Coverage is case-insensitive: a save-side WazaType id resolves regardless of the
        // localization key's casing, so an old-name id backed by a differently-cased waza key
        // is NOT a regression.
        var regressions = oldNameIds.Where(id => !activeSkills.ContainsKey(id)
            && !activeSkills.Keys.Any(k => string.Equals(k, id, StringComparison.OrdinalIgnoreCase))).ToList();
        var oldNameCI = new HashSet<string>(oldNameIds, StringComparer.OrdinalIgnoreCase);
        var wazaOnlyAdds = activeSkills.Keys.Where(id => !oldNameCI.Contains(id)).ToList();
        Console.WriteLine($"[active-skills] count={activeSkills.Count} wazaBacked={wazaBacked} nameOnly={activeSkills.Count - wazaBacked} wazaNoName={wazaNoName} oldNameSet={oldNameIds.Count}");
        Console.WriteLine($"[active-skills] elements=[{string.Join(",", activeElementKinds)}]");
        Console.WriteLine($"[active-skills] regressions vs old set ({regressions.Count}): {string.Join(", ", regressions)}");
        Console.WriteLine($"[active-skills] waza-only additions ({wazaOnlyAdds.Count}): {string.Join(", ", wazaOnlyAdds.Take(40))}");

        // ---- learnsets (level-up learnable actives) ----
        // DT_WazaMasterLevel: one row per (PalId, WazaID, Level) level-up entry, keyed
        // by species internal name. Filter to waza ids present in the active-skills set
        // (never fabricate — report misses); emit the canonical active-skills id casing
        // so the pack/paldex join is exact. Element-swap variants carry their own rows
        // and are grouped independently by PalId.
        var wazaMaster = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Waza/DT_WazaMasterLevel");
        var wazaCanon = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var id in activeSkills.Keys) wazaCanon[id] = id;
        var learnRaw = new Dictionary<string, List<(int level, string waza)>>(StringComparer.Ordinal);
        var learnWazaMiss = new SortedSet<string>(StringComparer.Ordinal);
        int learnKept = 0, learnSkippedNonSpecies = 0;
        foreach (var r in wazaMaster.RowMap)
        {
            var lv = Vals(r.Value);
            var palId = S(lv, "PalId");
            var wazaId = StripEnum(S(lv, "WazaID"));
            int level = I(lv, "Level");
            if (string.IsNullOrEmpty(palId) || string.IsNullOrEmpty(wazaId) || wazaId == "None") continue;
            if (!species.ContainsKey(palId)) { learnSkippedNonSpecies++; continue; } // BOSS_/summon/cut PalIds
            if (!wazaCanon.TryGetValue(wazaId, out var canon)) { learnWazaMiss.Add($"{palId}:{wazaId}"); continue; }
            (learnRaw.TryGetValue(palId, out var l) ? l : (learnRaw[palId] = new List<(int, string)>())).Add((level, canon));
            learnKept++;
        }
        var learnsets = new SortedDictionary<string, object>(StringComparer.Ordinal);
        foreach (var kv in learnRaw)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var rows = kv.Value.OrderBy(x => x.level)
                .Where(x => seen.Add(x.level + ":" + x.waza))
                .Select(x => (object)new { waza_id = x.waza, level = x.level })
                .ToList();
            learnsets[kv.Key] = rows;
        }
        Console.WriteLine($"[learnsets] table=DT_WazaMasterLevel rows={wazaMaster.RowMap.Count} kept={learnKept} speciesCovered={learnsets.Count}/{kept} skippedNonSpecies={learnSkippedNonSpecies} wazaMisses={learnWazaMiss.Count}");
        if (learnWazaMiss.Count > 0) Console.WriteLine($"[learnset waza misses {learnWazaMiss.Count}] {string.Join(" | ", learnWazaMiss.Take(60))}");

        // ---- assemble + write ----
        var root = new
        {
            meta = new
            {
                game_build = GameBuild,
                extracted_at = DateTimeOffset.UtcNow.ToString("o"),
                usmap = UsmapSource,
            },
            game_settings = gameSettings,
            species,
            passives,
            active_skills = activeSkills,
            learnsets,
            breeding_boosts = breedingBoosts,
        };
        Directory.CreateDirectory(OutDir);
        var outPath = Path.Combine(OutDir, "extracted-game-data.json");
        File.WriteAllText(outPath, JsonConvert.SerializeObject(root, Formatting.Indented));
        Console.WriteLine($"[write] {outPath}");

        // ---- validation gates ----
        var errors = new List<string>();
        void Gate(bool ok, string msg) { if (!ok) errors.Add(msg); }

        Gate(kept >= 299, $"species count {kept} < 299");

        string LamballKey = displayByInternal.FirstOrDefault(kv => string.Equals(kv.Value, "Lamball", StringComparison.OrdinalIgnoreCase)).Key ?? "SheepBall";
        string JormKey = displayByInternal.FirstOrDefault(kv => string.Equals(kv.Value, "Jormuntide", StringComparison.OrdinalIgnoreCase)).Key ?? "Umihebi";

        var lamball = species.TryGetValue(LamballKey, out var lo) ? lo : null;
        Gate(lamball != null, $"Lamball ({LamballKey}) not in species");
        string lamballPartner = lamball == null ? null : (string)GetProp(GetProp(lamball, "partner_skill"), "name");
        Gate(lamballPartner == "Fluffy Shield", $"Lamball partner name '{lamballPartner}' != 'Fluffy Shield'");

        var jorm = species.TryGetValue(JormKey, out var jo) ? jo : null;
        Gate(jorm != null, $"Jormuntide ({JormKey}) not in species");
        var jormElems = jorm == null ? new List<string>() : (List<string>)GetProp(jorm, "elements");
        Gate(jormElems.SequenceEqual(new[] { "Dragon", "Water" }), $"Jormuntide elements [{string.Join(",", jormElems)}] != [Dragon,Water]");

        Gate(((System.Collections.IEnumerable)(((IDictionary<string, object>)gameSettings)["combi_talent_inherit_num"])).Cast<object>().Any(), "Combi_TalentInheritNum empty");
        Gate(((System.Collections.IEnumerable)(((IDictionary<string, object>)gameSettings)["combi_passive_inherit_num"])).Cast<object>().Any(), "Combi_PassiveInheritNum empty");
        Gate(((System.Collections.IEnumerable)(((IDictionary<string, object>)gameSettings)["combi_passive_random_add_num"])).Cast<object>().Any(), "Combi_PassiveRandomAddNum empty");

        foreach (var kv in species)
        {
            var el = (List<string>)GetProp(kv.Value, "elements");
            if (el.Count < 1 || el.Count > 2) { Gate(false, $"{kv.Key} has {el.Count} elements"); break; }
        }
        Gate(partnerHit == kept, $"partner coverage {partnerHit}/{kept}");

        // partner description contains the authored shield text
        string lamballDesc = lamball == null ? null : (string)GetProp(GetProp(lamball, "partner_skill"), "description");
        Gate(lamballDesc != null && lamballDesc.Contains("becomes a shield", StringComparison.OrdinalIgnoreCase),
            $"Lamball partner desc missing 'becomes a shield': '{lamballDesc}'");

        // partner-skill template resolution: no description may retain an unresolved {placeholder}
        int descsWithBraces = species.Values.Count(sp =>
        {
            var ps = GetProp(sp, "partner_skill"); var d = ps == null ? null : (string)GetProp(ps, "description");
            return d != null && d.Contains('{');
        });
        Gate(descsWithBraces == 0, $"{descsWithBraces} partner descriptions still contain unresolved '{{' placeholders (see [partner-template UNRESOLVED])");
        Gate(partnerTemplateMiss.Count == 0, $"{partnerTemplateMiss.Count} unresolved partner-skill templates: {string.Join(" | ", partnerTemplateMiss.Take(20))}");
        // Cattiva (PinkCat) carry-capacity {Passive1_EffectValue1} must resolve to the numeric range
        var cattiva = species.TryGetValue("PinkCat", out var pc) ? pc : null;
        string cattivaDesc = cattiva == null ? null : (string)GetProp(GetProp(cattiva, "partner_skill"), "description");
        Gate(cattivaDesc != null && cattivaDesc.Contains("100~200"),
            $"Cattiva(PinkCat) partner desc missing carry-capacity range '100~200': '{cattivaDesc}'");
        // Cattiva per-LEVEL template: 1 varying slot, 5 ascending values 100..200.
        string cattivaTpl = cattiva == null ? null : (string)GetProp(GetProp(cattiva, "partner_skill"), "template");
        var cattivaVals = cattiva == null ? null : (List<List<string>>)GetProp(GetProp(cattiva, "partner_skill"), "values");
        Gate(cattivaTpl != null && cattivaTpl.Contains("{0}"), $"Cattiva(PinkCat) partner template missing '{{0}}' slot: '{cattivaTpl}'");
        Gate(cattivaVals != null && cattivaVals.Count == 1, $"Cattiva(PinkCat) expected 1 template slot, got {(cattivaVals?.Count.ToString() ?? "null")}");
        if (cattivaVals != null && cattivaVals.Count == 1)
            Gate(cattivaVals[0].SequenceEqual(new[] { "100", "120", "140", "160", "200" }),
                $"Cattiva(PinkCat) slot values [{string.Join(",", cattivaVals[0])}] != [100,120,140,160,200]");

        // Learnsets: coverage + spot-checks (never fabricated — only ids in the active-skills set).
        Gate(learnsets.Count >= 200, $"learnset species coverage {learnsets.Count} unexpectedly low");
        Gate(learnWazaMiss.Count == 0, $"{learnWazaMiss.Count} learnset waza ids not in active-skills set: {string.Join(" | ", learnWazaMiss.Take(20))}");
        var anubisLearn = learnsets.TryGetValue("Anubis", out var alo) ? (List<object>)alo : null;
        Gate(anubisLearn != null && anubisLearn.Count > 0, "Anubis learnset missing/empty");
        if (anubisLearn != null && anubisLearn.Count > 0)
        {
            int lvl1 = (int)GetProp(anubisLearn[0], "level");
            Gate(lvl1 == 1, $"Anubis first learnset entry level {lvl1} != 1");
        }
        var sheepLearn = learnsets.TryGetValue(LamballKey, out var slo) ? (List<object>)slo : null;
        Gate(sheepLearn != null && sheepLearn.Count > 0, $"Lamball ({LamballKey}) learnset missing/empty");

        // passives sanity
        object FindPassive(string dn) => passives.Values.FirstOrDefault(p => (string)GetProp(p, "name") == dn);
        int EffCount(object p) => p == null ? 0 : ((List<object>)GetProp(p, "effects")).Count;
        var legend = FindPassive("Legend");
        Gate(legend != null && (int)GetProp(legend, "rank") >= 3 && EffCount(legend) > 0,
            $"Legend passive missing / rank<3 / no effects (rank={(legend == null ? "n/a" : GetProp(legend, "rank"))}, eff={EffCount(legend)})");
        var lucky = FindPassive("Lucky");
        Gate(lucky != null && EffCount(lucky) > 0, $"Lucky passive missing / no effects (eff={EffCount(lucky)})");
        var brittle = FindPassive("Brittle") ?? passives.Values.FirstOrDefault(p => (int)GetProp(p, "rank") < 0);
        Gate(brittle != null && (int)GetProp(brittle, "rank") < 0,
            $"no negative-rank passive found (Brittle rank={(brittle == null ? "n/a" : GetProp(brittle, "rank"))})");
        Gate(passKept > 200, $"passive count {passKept} unexpectedly low");
        if (passPalAny != 114)
            Console.WriteLine($"[WARN] pal-passive count (any pool) {passPalAny} != 114 (paldb ref); AddPal-only={passAddPal} — game version may differ");

        // active skills: expect several hundred; coverage must not regress below the old name set.
        Gate(activeSkills.Count >= 300, $"active_skills count {activeSkills.Count} < 300");
        Gate(regressions.Count == 0, $"active_skills regressed {regressions.Count} old-name ids: {string.Join(", ", regressions.Take(20))}");
        var airRow = activeSkills.TryGetValue("AirCanon", out var ao) ? ao : null;
        Gate(airRow != null, "active_skills missing 'AirCanon'");
        if (airRow != null)
        {
            Gate((string)GetProp(airRow, "name") == "Air Cannon", $"AirCanon name '{GetProp(airRow, "name")}' != 'Air Cannon'");
            Gate((string)GetProp(airRow, "element") == "Normal", $"AirCanon element '{GetProp(airRow, "element")}' != 'Normal'");
            var airPow = (int?)GetProp(airRow, "power");
            Gate(airPow.HasValue && airPow.Value > 0, $"AirCanon power {(airPow?.ToString() ?? "null")} not > 0");
        }
        var sbRow = activeSkills.TryGetValue("Unique_SheepBall_Roll", out var sbo) ? sbo : null;
        Gate(sbRow != null && !string.IsNullOrEmpty((string)GetProp(sbRow, "name")),
            "active_skills missing resolvable 'Unique_SheepBall_Roll'");

        // breeding boosts: the four known partner skills + Babysitter must resolve with the
        // documented per-rank ranges (validation set for the effect-key discovery).
        object FindBoost(string src, string eff) => breedingBoosts.FirstOrDefault(b =>
            (string)GetProp(b, "source") == src && (string)GetProp(b, "effect") == eff);
        List<double> BoostVals(object b) => b == null ? null : (List<double>)GetProp(b, "values_per_rank");
        void GateBoost(string src, string eff, string kind, double lo, double hi)
        {
            var b = FindBoost(src, eff);
            Gate(b != null, $"breeding boost {src}/{eff} missing");
            if (b == null) return;
            Gate((string)GetProp(b, "source_kind") == kind, $"{src}/{eff} kind '{GetProp(b, "source_kind")}' != {kind}");
            var vs = BoostVals(b);
            Gate(vs != null && vs.Count >= 1 && Math.Abs(vs.First() - lo) < 1e-6 && Math.Abs(vs.Last() - hi) < 1e-6,
                $"{src}/{eff} range [{(vs == null ? "null" : string.Join(",", vs.Select(FmtNum)))}] != [{FmtNum(lo)}..{FmtNum(hi)}]");
        }
        GateBoost("Plesiosaur", "farm_speed", "partner_base", 0.20, 0.50);
        GateBoost("ThunderFluffyBird", "incubation_speed", "partner_base", 0.20, 0.40);
        GateBoost("NaughtyCat", "extra_egg_chance", "partner_party", 0.50, 0.75);
        GateBoost("SakuraSaurus", "alpha_egg_chance", "partner_party", 0.35, 0.45);
        var baby = FindBoost("MutationPal_Babysitter", "incubation_speed");
        Gate(baby != null, "Babysitter incubation_speed boost missing");
        Gate(FindBoost("MutationPal_Babysitter", "farm_speed") != null, "Babysitter farm_speed boost missing");

        // ---- summary ----
        Console.WriteLine("==== SUMMARY ====");
        Console.WriteLine($"species kept={kept} skipped={skipped}");
        Console.WriteLine($"partner-skill coverage={partnerHit}/{kept}");
        var gs = (IDictionary<string, object>)gameSettings;
        Console.WriteLine($"combi_talent_inherit_num       = [{string.Join(", ", ((IEnumerable<object>)gs["combi_talent_inherit_num"]))}]");
        Console.WriteLine($"combi_passive_inherit_num      = [{string.Join(", ", ((IEnumerable<object>)gs["combi_passive_inherit_num"]))}]");
        Console.WriteLine($"combi_passive_random_add_num   = [{string.Join(", ", ((IEnumerable<object>)gs["combi_passive_random_add_num"]))}]");
        Console.WriteLine($"other game_settings keys=[{string.Join(",", gs.Keys)}]");
        Console.WriteLine($"element icon variants exported: {string.Join(", ", iconVariants)}");
        if (lamball != null)
        {
            Console.WriteLine($"Lamball({LamballKey}) partner={lamballPartner}");
            Console.WriteLine("Lamball stats: " + JsonConvert.SerializeObject(GetProp(lamball, "stats")));
            Console.WriteLine("Lamball elements: " + JsonConvert.SerializeObject(GetProp(lamball, "elements")));
        }
        if (lamball != null)
            Console.WriteLine("Lamball partner desc: " + JsonConvert.SerializeObject(lamballDesc));
        Console.WriteLine("Cattiva(PinkCat) partner template: " + JsonConvert.SerializeObject(cattivaTpl));
        Console.WriteLine("Cattiva(PinkCat) partner values:   " + JsonConvert.SerializeObject(cattivaVals));
        Console.WriteLine($"learnsets: table=DT_WazaMasterLevel speciesCovered={learnsets.Count}/{kept} kept={learnKept} wazaMisses={learnWazaMiss.Count}");
        Console.WriteLine("Anubis learnset: " + JsonConvert.SerializeObject(anubisLearn));
        Console.WriteLine($"per-level partner: speciesWithTemplate={partnerTemplatesEmitted} totalSlots={partnerTemplateSlotTotal}");
        Console.WriteLine($"passives kept={passKept} (filtered noName={passFilteredNoName} stub={passFilteredStub}); is_pal(anyPool)={passPalAny} is_pal(AddPal)={passAddPal} is_player={passPlayer}");
        Console.WriteLine($"partner-desc coverage={partnerDescHit}/{kept}; partner-icon distinct={partnerIconIds.Count} pngExported={iconExported}");
        Console.WriteLine("sample passive Lucky:   " + JsonConvert.SerializeObject(FindPassive("Lucky")));
        Console.WriteLine("sample passive Legend:  " + JsonConvert.SerializeObject(FindPassive("Legend")));
        Console.WriteLine("sample passive Brittle: " + JsonConvert.SerializeObject(FindPassive("Brittle")));
        Console.WriteLine($"wall time: {sw.Elapsed.TotalSeconds:F1}s");

        Console.WriteLine($"active_skills count={activeSkills.Count} (wazaBacked={wazaBacked})");
        foreach (var k in new[] { "AirCanon", "Unique_SheepBall_Roll", "FireBall" })
            Console.WriteLine($"  active_skill[{k}] = {(activeSkills.TryGetValue(k, out var an) ? JsonConvert.SerializeObject(an) : "(MISSING)")}");
        if (errors.Count > 0)
        {
            Console.WriteLine("==== VALIDATION FAILED ====");
            foreach (var e in errors) Console.WriteLine("  FAIL: " + e);
            return 1;
        }
        Console.WriteLine("==== ALL GATES PASSED ====");
        return 0;
    }

    // Reusable discovery pass (`--discover`): full-text search every L10N/en text DataTable
    // for target UI strings, reporting the containing table path + row key. Used to locate
    // authored descriptions whose row-key scheme is unknown (e.g. partner-skill descriptions).
    static void Discover(IFileProvider provider)
    {
        string[] needles = { "becomes a shield", "Sometimes drops" };
        Console.WriteLine($"[discover] needles: {string.Join(" | ", needles)}");
        int scanned = 0, hits = 0;
        foreach (var f in provider.Files.Keys.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!f.EndsWith(".uasset") || !f.Contains("/L10N/en/", StringComparison.OrdinalIgnoreCase)) continue;
            var pkgPath = f.Substring(0, f.Length - ".uasset".Length);
            UDataTable dt;
            try { if (!provider.TryLoadPackageObject(pkgPath, out var o) || o is not UDataTable d) continue; dt = d; }
            catch { continue; }
            scanned++;
            foreach (var row in dt.RowMap)
            {
                string txt;
                try { txt = row.Value.Get<FText>("TextData")?.Text; } catch { continue; }
                if (txt == null) continue;
                foreach (var needle in needles)
                    if (txt.Contains(needle, StringComparison.OrdinalIgnoreCase))
                    { Console.WriteLine($"  HIT [{needle}] {pkgPath} row='{row.Key.Text}' :: {txt.Replace("\n", " ").Trim()}"); hits++; }
            }
        }
        Console.WriteLine($"[discover] scanned={scanned} datatables hits={hits}");
    }

    // Reusable discovery pass (`--discover-learnset`): find the level-up learnset
    // data table and dump its row schema. Prints every .uasset whose name mentions
    // MasterLevel/WazaMaster/Learn/LevelUp, then loads each as a UDataTable and
    // dumps row count, first few keys, and the first row's property names + a
    // shallow value preview so the emit path can be written against real shape.
    static void DiscoverLearnset(IFileProvider provider)
    {
        var needles = new[] { "masterlevel", "wazamaster", "learnset", "learnwaza", "wazalearn", "levelup" };
        var cands = provider.Files.Keys
            .Where(f => f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Where(f => needles.Any(n => Path.GetFileNameWithoutExtension(f).Contains(n, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        Console.WriteLine($"[discover-learnset] candidate files ({cands.Count}):");
        foreach (var f in cands) Console.WriteLine($"  {f}");
        foreach (var f in cands)
        {
            var pkgPath = f.Substring(0, f.Length - ".uasset".Length);
            UDataTable dt;
            try { if (!provider.TryLoadPackageObject(pkgPath, out var o) || o is not UDataTable d) { Console.WriteLine($"[skip non-datatable] {pkgPath}"); continue; } dt = d; }
            catch (Exception e) { Console.WriteLine($"[load fail] {pkgPath}: {e.Message}"); continue; }
            Console.WriteLine($"==== {pkgPath} rows={dt.RowMap.Count} ====");
            int shown = 0;
            foreach (var r in dt.RowMap)
            {
                if (shown++ >= 4) break;
                Console.WriteLine($"  row '{r.Key.Text}': props=[{string.Join(", ", r.Value.Properties.Select(p => p.Name.Text))}]");
                foreach (var p in r.Value.Properties)
                {
                    var gv = p.Tag?.GenericValue;
                    string preview;
                    if (gv is UScriptArray arr)
                        preview = $"array[{arr.Properties.Count}] first=" + (arr.Properties.Count > 0 ? DumpStruct(arr.Properties[0].GenericValue) : "(empty)");
                    else preview = gv?.ToString() ?? "null";
                    if (preview.Length > 300) preview = preview.Substring(0, 300) + "...";
                    Console.WriteLine($"      {p.Name.Text} = {preview}");
                }
            }
        }
    }

    // Reusable discovery pass (`--discover-breeding`): locate the TYPED sources of
    // breeding/egg/incubation effects without parsing description text. Dumps (1) every
    // distinct EPalPassiveSkillEffectType value used across DT_PassiveSkill_Main, flagging
    // breeding-relevant ones by keyword; (2) every passive carrying such an effect; (3) each
    // partner-skill param row's schema, its trigger condition, and the referenced
    // DT_PassiveSkill_Main rows' effect types + per-rank values so the emit path can classify
    // by effect key (not species name).
    static void DiscoverBreeding(IFileProvider provider)
    {
        var passiveMain = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/PassiveSkill/DT_PassiveSkill_Main");
        var partnerParam = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/PassiveSkill/DT_PartnerSkillParameter");
        var passiveRowByName = new Dictionary<string, FStructFallback>(StringComparer.OrdinalIgnoreCase);
        foreach (var pr in passiveMain.RowMap) passiveRowByName[pr.Key.Text] = pr.Value;

        bool IsBreedEff(string et) => et != null && (
            et.Contains("Breed", StringComparison.OrdinalIgnoreCase)
            || et.Contains("Egg", StringComparison.OrdinalIgnoreCase)
            || et.Contains("Incubat", StringComparison.OrdinalIgnoreCase)
            || et.Contains("Hatch", StringComparison.OrdinalIgnoreCase));

        // (1) every distinct EffectType across DT_PassiveSkill_Main
        var effTypes = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var r in passiveMain.RowMap)
        {
            var v = Vals(r.Value);
            for (int i = 1; i <= 4; i++)
            {
                var et = StripEnum(S(v, "EffectType" + i));
                if (string.IsNullOrEmpty(et) || et == "None" || et == "no") continue;
                effTypes[et] = effTypes.TryGetValue(et, out var c) ? c + 1 : 1;
            }
        }
        Console.WriteLine($"[breeding-discover] distinct EffectType values in DT_PassiveSkill_Main ({effTypes.Count}):");
        foreach (var kv in effTypes)
            Console.WriteLine($"    {(IsBreedEff(kv.Key) ? "**BREED**" : "         ")} {kv.Value,4}  {kv.Key}");

        // (2) every passive row carrying a breeding-relevant effect
        Console.WriteLine("[breeding-discover] passive rows with breeding effect:");
        foreach (var r in passiveMain.RowMap)
        {
            var v = Vals(r.Value);
            var hits = new List<string>();
            for (int i = 1; i <= 4; i++)
            {
                var et = StripEnum(S(v, "EffectType" + i));
                if (IsBreedEff(et)) hits.Add($"{et}={FmtNum(F(v, "EffectValue" + i))}(tgt={StripEnum(S(v, "TargetType" + i))})");
            }
            if (hits.Count > 0) Console.WriteLine($"    row '{r.Key.Text}': {string.Join(", ", hits)}");
        }

        // (3) partner-skill param rows: schema + trigger + referenced passive effect types
        Console.WriteLine($"[breeding-discover] DT_PartnerSkillParameter rows={partnerParam.RowMap.Count}");
        int shownSchema = 0;
        foreach (var r in partnerParam.RowMap)
        {
            var row = r.Value;
            if (shownSchema++ < 3)
                Console.WriteLine($"    SCHEMA row '{r.Key.Text}': props=[{string.Join(", ", row.Properties.Select(p => p.Name.Text))}]");
            // Collect referenced passive rows across both arrays, resolve their effect types.
            var refBreed = new List<string>();
            foreach (var (arrayField, innerField) in new[] { ("PassiveSkills", "SkillAndParametersArray"), ("TextReferencePassiveSkills", "PassiveSkillIds") })
            {
                var ranks = AsArray(Prop(row, arrayField));
                if (ranks == null) continue;
                foreach (var rankEl in ranks.Properties)
                {
                    var inner = AsArray(Prop(AsStruct(rankEl.GenericValue), innerField));
                    if (inner == null) continue;
                    foreach (var entry in inner.Properties)
                    {
                        var es = AsStruct(entry.GenericValue);
                        var key = FNameText(Prop(es, "Key")) ?? FNameText(Prop(AsStruct(Prop(es, "SkillName")), "Key"));
                        if (key == null || !passiveRowByName.TryGetValue(key, out var prow)) continue;
                        var pv = Vals(prow);
                        for (int i = 1; i <= 4; i++)
                        {
                            var et = StripEnum(S(pv, "EffectType" + i));
                            if (IsBreedEff(et)) refBreed.Add($"{arrayField}->{key}:{et}={FmtNum(F(pv, "EffectValue" + i))}(tgt={StripEnum(S(pv, "TargetType" + i))})");
                        }
                    }
                }
            }
            // Trigger condition candidates (any field whose name hints at base/party/timing).
            var trig = row.Properties
                .Where(p => { var n = p.Name.Text; return n.Contains("Trigger") || n.Contains("Condition") || n.Contains("Timing") || n.Contains("Base") || n.Contains("Party") || n.Contains("Type"); })
                .Select(p => $"{p.Name.Text}={StripEnum(p.Tag?.GenericValue?.ToString())}")
                .ToList();
            if (refBreed.Count > 0)
                Console.WriteLine($"    BREED-PARTNER '{r.Key.Text}': trigger=[{string.Join(", ", trig)}] | {string.Join(" | ", refBreed.Distinct())}");
        }
    }

    static string DumpStruct(object v)
    {
        var s = AsStruct(v);
        if (s == null) return v?.ToString() ?? "null";
        return "{" + string.Join(", ", s.Properties.Select(p => $"{p.Name.Text}={p.Tag?.GenericValue}")) + "}";
    }

    // ---- partner-skill template resolution ----
    // Partner-skill descriptions (DT_PalFirstActivatedInfoText) embed {templates} the game fills
    // per partner-skill LEVEL (rank 1..N). Mapping learned by dumping DT_PartnerSkillParameter
    // (Pal/Content/Pal/DataTable/PassiveSkill/DT_PartnerSkillParameter, keyed by species internal name):
    //   PassiveSkills[]              one entry per rank; entry.SkillAndParametersArray[N-1].SkillName.Key
    //                                -> a DT_PassiveSkill_Main row whose EffectValue<M> feeds {PassiveN_EffectValueM}.
    //   TextReferencePassiveSkills[] one entry per rank; entry.PassiveSkillIds[N-1].Key -> a
    //                                DT_PassiveSkill_Main row -> {ReferencePassiveN_EffectValueM}.
    //   ActiveSkill.ActiveSkill_MainValueByRank[]           -> {ActiveSkillMainValueByRank}
    //   ActiveSkill.ActiveSkill_OverWriteEffectTimeByRank[] -> {ActiveSkillOverWriteEffectTime}
    //   {ReferenceMsgId_X} -> DT_PartnerSkillAppendText row "X_Rank_1" (the game shows the Lv.1 append
    //     message; every current _Rank_1 row is blank, so paldb renders these as nothing). Resolved
    //     text is re-substituted (cycle-guarded) then rich-tag-cleaned by the shared Clean() pass.
    // POLICY (matches paldb): compute each numeric placeholder at EVERY rank; emit the single value
    //   if constant across ranks, else "(min~max)". Unresolvable templates are left verbatim + reported.

    // True if a DT_PartnerSkillParameter row carries any per-rank template data (non-stub); used to
    // skip element-swap variant stubs and inherit the base pal's row.
    static bool HasTemplateData(FStructFallback param)
    {
        if (param == null) return false;
        if (AsArray(Prop(param, "PassiveSkills"))?.Properties.Count > 0) return true;
        if (AsArray(Prop(param, "TextReferencePassiveSkills"))?.Properties.Count > 0) return true;
        var active = AsStruct(Prop(param, "ActiveSkill"));
        return AsArray(Prop(active, "ActiveSkill_MainValueByRank"))?.Properties.Count > 0
            || AsArray(Prop(active, "ActiveSkill_OverWriteEffectTimeByRank"))?.Properties.Count > 0;
    }

    // ---- breeding-boost extraction (typed, source-agnostic) ----
    // Breeding/egg/incubation boosts live as TYPED effects on DT_PassiveSkill_Main rows
    // (EPalPassiveSkillEffectType), never as parsed description text. Discovered set (build
    // 24181527, see `--discover-breeding`): BreedSpeed / BreedSpeed_InBaseCamp (farm egg-
    // production speed), PalEggHatchingSpeed (incubation), EggObtainExtraEgg (extra-egg
    // chance), EggAlphaConversion (alpha-egg chance, cosmetic). Partner skills grant these
    // via their per-rank PassiveSkills[] refs; passives (e.g. Babysitter) carry them inline.
    // The frozen `effect` contract collapses the five raw types onto four buckets.
    static readonly Dictionary<string, string> BreedEffectMap = new(StringComparer.Ordinal)
    {
        ["BreedSpeed"] = "farm_speed",
        ["BreedSpeed_InBaseCamp"] = "farm_speed",
        ["PalEggHatchingSpeed"] = "incubation_speed",
        ["EggObtainExtraEgg"] = "extra_egg_chance",
        ["EggAlphaConversion"] = "alpha_egg_chance",
    };
    static string BreedEffect(string et) => et != null && BreedEffectMap.TryGetValue(et, out var e) ? e : null;

    // Per-rank breeding boosts granted by a partner-skill param row. Scans PassiveSkills[]
    // (the passives ACTUALLY granted per rank — TextReferencePassiveSkills[] is display-only)
    // and, per breeding effect type, collects the fraction value at each rank in ascending
    // rank order. `target` is the raw TargetType (ToBuildObject = at-base, ToTrainer = in-party)
    // that drives partner_base vs partner_party. Empty for non-breeding partner skills.
    static List<(string effect, string target, List<double> valsPerRank)> PartnerBreedingBoosts(
        FStructFallback param, Dictionary<string, FStructFallback> passiveRows)
    {
        // effect-type -> (raw target, per-rank fractions)
        var acc = new Dictionary<string, (string target, List<double> vals)>(StringComparer.Ordinal);
        var ranks = AsArray(Prop(param, "PassiveSkills"));
        if (ranks != null)
            foreach (var rankEl in ranks.Properties) // rank-1..N ascending
            {
                var inner = AsArray(Prop(AsStruct(rankEl.GenericValue), "SkillAndParametersArray"));
                if (inner == null) continue;
                foreach (var entry in inner.Properties)
                {
                    var es = AsStruct(entry.GenericValue);
                    var key = FNameText(Prop(es, "Key")) ?? FNameText(Prop(AsStruct(Prop(es, "SkillName")), "Key"));
                    if (key == null || !passiveRows.TryGetValue(key, out var prow)) continue;
                    var pv = Vals(prow);
                    for (int i = 1; i <= 4; i++)
                    {
                        var et = StripEnum(S(pv, "EffectType" + i));
                        if (BreedEffect(et) == null) continue;
                        var tgt = StripEnum(S(pv, "TargetType" + i));
                        if (!acc.TryGetValue(et, out var e)) { e = (tgt, new List<double>()); acc[et] = e; }
                        e.vals.Add(F(pv, "EffectValue" + i) / 100.0);
                        acc[et] = e;
                    }
                }
            }
        return acc.Select(kv => (BreedEffect(kv.Key), kv.Value.target, kv.Value.vals)).ToList();
    }

    // Every DT_PassiveSkill_Main row key referenced by ANY partner-skill param's PassiveSkills[]
    // (the partner-internal component rows). Excluded from the standalone-passive breeding pass
    // so partner boosts aren't double-counted as passives.
    static HashSet<string> PartnerReferencedPassiveRows(UDataTable partnerParam)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pr in partnerParam.RowMap)
        {
            var ranks = AsArray(Prop(pr.Value, "PassiveSkills"));
            if (ranks == null) continue;
            foreach (var rankEl in ranks.Properties)
            {
                var inner = AsArray(Prop(AsStruct(rankEl.GenericValue), "SkillAndParametersArray"));
                if (inner == null) continue;
                foreach (var entry in inner.Properties)
                {
                    var es = AsStruct(entry.GenericValue);
                    var key = FNameText(Prop(es, "Key")) ?? FNameText(Prop(AsStruct(Prop(es, "SkillName")), "Key"));
                    if (key != null) set.Add(key);
                }
            }
        }
        return set;
    }
    static readonly Regex TplRefPassive = new(@"\{ReferencePassive(\d+)_EffectValue(\d+)\}");
    static readonly Regex TplPassive = new(@"\{Passive(\d+)_EffectValue(\d+)\}");
    static readonly Regex TplRefMsg = new(@"\{ReferenceMsgId_([A-Za-z0-9_]+)\}");

    static string ResolvePartnerTemplates(string raw, FStructFallback param,
        Dictionary<string, FStructFallback> passiveRows, Dictionary<string, string> append,
        ISet<string> unresolved, IDictionary<string, int> fam)
        => raw == null ? null : Sub(raw, param, passiveRows, append, unresolved, fam, new HashSet<string>());

    static string Sub(string s, FStructFallback param, Dictionary<string, FStructFallback> passiveRows,
        Dictionary<string, string> append, ISet<string> unresolved, IDictionary<string, int> fam, HashSet<string> seenMsg)
    {
        s = TplRefPassive.Replace(s, m => Tally("ReferencePassive", ResolveRankPassive(param, "TextReferencePassiveSkills", "PassiveSkillIds",
            int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), passiveRows), m.Value, unresolved, fam));
        s = TplPassive.Replace(s, m => Tally("Passive", ResolveRankPassive(param, "PassiveSkills", "SkillAndParametersArray",
            int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), passiveRows), m.Value, unresolved, fam));
        s = ReplaceActive(s, "{ActiveSkillMainValueByRank}", param, "ActiveSkill_MainValueByRank", "ActiveSkillMainValueByRank", unresolved, fam);
        s = ReplaceActive(s, "{ActiveSkillOverWriteEffectTime}", param, "ActiveSkill_OverWriteEffectTimeByRank", "ActiveSkillOverWriteEffectTime", unresolved, fam);
        s = TplRefMsg.Replace(s, m =>
        {
            var id = m.Groups[1].Value;
            if (!seenMsg.Add(id)) return "";                                  // cycle guard
            if (!append.TryGetValue(id + "_Rank_1", out var txt) || txt == null) { unresolved.Add(m.Value); return m.Value; }
            Bump(fam, "ReferenceMsgId");
            return Sub(txt, param, passiveRows, append, unresolved, fam, seenMsg); // recurse into referenced text
        });
        return s;
    }

    static string Tally(string family, string resolved, string original, ISet<string> unresolved, IDictionary<string, int> fam)
    { if (resolved == null) { unresolved.Add(original); return original; } Bump(fam, family); return resolved; }
    static void Bump(IDictionary<string, int> fam, string k) => fam[k] = fam.TryGetValue(k, out var c) ? c + 1 : 1;

    // ---- partner-skill TEMPLATE builder (per-LEVEL values) ----
    // Same substitution graph as Sub(), but emits {0}..{N} slot markers where a placeholder's value
    // VARIES across ranks, baking the literal where it's constant. Returns (slotted template, per-slot
    // per-rank display values) or (null, null) when there are no varying slots or any placeholder is
    // unresolvable (honest: never half-templated). Element-swap variants reuse the base pal's param
    // row (same as the description path) and so inherit its template automatically.
    sealed class TplCtx
    {
        public FStructFallback Param;
        public Dictionary<string, FStructFallback> Rows;
        public Dictionary<string, string> Append;
        public List<List<string>> Values = new();
        public bool Failed;
        public HashSet<string> SeenMsg = new(StringComparer.Ordinal);
    }

    static (string template, List<List<string>> values) BuildPartnerTemplate(string s,
        FStructFallback param, Dictionary<string, FStructFallback> passiveRows, Dictionary<string, string> append)
    {
        if (s == null) return (null, null);
        var c = new TplCtx { Param = param, Rows = passiveRows, Append = append };
        var slotted = SubTemplate(s, c);
        if (c.Failed || c.Values.Count == 0) return (null, null);
        return (slotted, c.Values);
    }

    static string SubTemplate(string s, TplCtx c)
    {
        s = TplRefPassive.Replace(s, m => SlotOrConst(
            RankPassiveVals(c.Param, "TextReferencePassiveSkills", "PassiveSkillIds",
                int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), c.Rows), c));
        s = TplPassive.Replace(s, m => SlotOrConst(
            RankPassiveVals(c.Param, "PassiveSkills", "SkillAndParametersArray",
                int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), c.Rows), c));
        s = ReplaceActiveTpl(s, "{ActiveSkillMainValueByRank}", "ActiveSkill_MainValueByRank", c);
        s = ReplaceActiveTpl(s, "{ActiveSkillOverWriteEffectTime}", "ActiveSkill_OverWriteEffectTimeByRank", c);
        s = TplRefMsg.Replace(s, m =>
        {
            var id = m.Groups[1].Value;
            if (!c.SeenMsg.Add(id)) return "";                       // cycle guard (matches Sub)
            if (!c.Append.TryGetValue(id + "_Rank_1", out var txt) || txt == null) { c.Failed = true; return ""; }
            return SubTemplate(txt, c);                              // recurse (append rows are blank today)
        });
        return s;
    }

    // A resolved placeholder: bake the literal when constant across ranks, else consume a fresh slot.
    static string SlotOrConst(List<double> vals, TplCtx c)
    {
        if (vals == null || vals.Count == 0) { c.Failed = true; return ""; }
        var formatted = vals.Select(FmtNum).ToList();
        if (formatted.Distinct().Count() == 1) return formatted[0];  // constant across ranks -> literal
        int slot = c.Values.Count;
        c.Values.Add(formatted);
        return "{" + slot + "}";
    }

    static string ReplaceActiveTpl(string s, string token, string field, TplCtx c)
    {
        if (!s.Contains(token)) return s;
        var vals = ActiveArrayVals(c.Param, field);
        return new Regex(Regex.Escape(token)).Replace(s, _ => SlotOrConst(vals, c));
    }

    // Per-rank numeric values for {PassiveN_EffectValueM}/{ReferencePassiveN_EffectValueM}: EffectValueM
    // of the rank-r passive N across all ranks r (ascending), skipping ranks that don't resolve.
    static List<double> RankPassiveVals(FStructFallback param, string arrayField, string innerField,
        int n, int m, Dictionary<string, FStructFallback> passiveRows)
    {
        var ranks = AsArray(Prop(param, arrayField));
        var vals = new List<double>();
        if (ranks == null) return vals;
        foreach (var rankEl in ranks.Properties)
        {
            var inner = AsArray(Prop(AsStruct(rankEl.GenericValue), innerField));
            if (inner == null || inner.Properties.Count < n) continue;
            var entry = AsStruct(inner.Properties[n - 1].GenericValue);
            // RefPassive entries expose Key directly; PassiveSkills entries nest it under SkillName.
            var key = FNameText(Prop(entry, "Key")) ?? FNameText(Prop(AsStruct(Prop(entry, "SkillName")), "Key"));
            if (key != null && passiveRows.TryGetValue(key, out var prow))
            {
                var ev = Prop(prow, "EffectValue" + m);
                if (ev != null) vals.Add(Convert.ToDouble(ev));
            }
        }
        return vals;
    }

    // Single number if constant across ranks, else "(min~max)". null if none resolve.
    static string ResolveRankPassive(FStructFallback param, string arrayField, string innerField,
        int n, int m, Dictionary<string, FStructFallback> passiveRows)
        => FmtRange(RankPassiveVals(param, arrayField, innerField, n, m, passiveRows));

    static List<double> ActiveArrayVals(FStructFallback param, string field)
    {
        var arr = AsArray(Prop(AsStruct(Prop(param, "ActiveSkill")), field));
        return arr == null ? new List<double>() : arr.Properties.Select(p => Convert.ToDouble(p.GenericValue)).ToList();
    }

    static string ResolveActiveArray(FStructFallback param, string field)
    {
        var vals = ActiveArrayVals(param, field);
        return vals.Count == 0 ? null : FmtRange(vals);
    }

    static string ReplaceActive(string s, string token, FStructFallback param, string field, string family, ISet<string> unresolved, IDictionary<string, int> fam)
    {
        if (!s.Contains(token)) return s;
        var v = ResolveActiveArray(param, field);
        if (v == null) { unresolved.Add(token); return s; }
        Bump(fam, family);
        return s.Replace(token, v);
    }

    static object Prop(FStructFallback s, string name) => s?.Properties.FirstOrDefault(p => p.Name.Text == name)?.Tag?.GenericValue;
    static UScriptArray AsArray(object v) => v as UScriptArray;
    static FStructFallback AsStruct(object v) => v as FStructFallback ?? (v as FScriptStruct)?.StructType as FStructFallback;
    static string FNameText(object v) => v is FName fn ? fn.Text : null;
    static string FmtNum(double d) => d == Math.Floor(d) && Math.Abs(d) < 9.2e18
        ? ((long)d).ToString(System.Globalization.CultureInfo.InvariantCulture)
        : d.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
    static string FmtRange(List<double> vals)
    {
        if (vals == null || vals.Count == 0) return null;
        double mn = vals.Min(), mx = vals.Max();
        return mn == mx ? FmtNum(mn) : $"({FmtNum(mn)}~{FmtNum(mx)})";
    }

    // internalName -> matching table key, stripping trailing _Variant suffixes until a key exists
    static string ResolveVariantKey(Func<string, bool> exists, string prefix, string internalName)
    {
        var n = internalName;
        while (true)
        {
            if (exists(prefix + n)) return prefix + n;
            var idx = n.LastIndexOf('_');
            if (idx < 0) return null;
            n = n.Substring(0, idx);
        }
    }

    // resolve <itemName id=|X|/> style rich tags to their English display text, drop <img>, then
    // substitute the per-rank {templates} (see ResolvePartnerTemplates), and strip remaining tags.
    static string CleanPartnerDesc(string raw, Dictionary<string, string> pal, Dictionary<string, string> item,
        Dictionary<string, string> mapobj, Dictionary<string, string> ui, Dictionary<string, string> skill,
        FStructFallback param, Dictionary<string, FStructFallback> passiveRows, Dictionary<string, string> append,
        ISet<string> unresolved, IDictionary<string, int> fam,
        out string template, out List<List<string>> templateValues)
    {
        template = null; templateValues = null;
        if (raw == null) return null;
        string s = IdTag.Replace(raw, m =>
        {
            var tag = m.Groups[1].Value; var id = m.Groups[2].Value;
            return tag switch
            {
                "itemName" => item.TryGetValue("ITEM_NAME_" + id, out var x) ? x : id,
                "mapObjectName" => mapobj.TryGetValue("MAPOBJECT_NAME_" + id, out var x) ? x : id,
                "characterName" => pal.TryGetValue("PAL_NAME_" + id, out var x) ? x : id,
                "uiCommon" => ui.TryGetValue(id, out var x) ? x : id,
                "img" => "",
                // active-skill refs (e.g. Unique_Baphomet_SwallowKite -> "Hellfire Claw"); safe: only replaces on lookup hit
                _ => skill.TryGetValue("ACTION_SKILL_" + id, out var x) ? x : id,
            };
        });
        // Per-LEVEL template from the SAME id-resolved text (before the range substitution mutates it):
        // slot markers where a value varies across ranks, literals where constant. Emitted only when at
        // least one varying slot exists and every placeholder resolved (BuildPartnerTemplate returns null
        // otherwise). Clean() leaves the {N} markers intact (they are not rich tags).
        var (tpl, vals) = BuildPartnerTemplate(s, param, passiveRows, append);
        if (tpl != null)
        {
            var cleanedTpl = Clean(tpl);
            if (!string.IsNullOrEmpty(cleanedTpl)) { template = cleanedTpl; templateValues = vals; }
        }
        s = ResolvePartnerTemplates(s, param, passiveRows, append, unresolved, fam);
        var cleaned = Clean(s);
        return string.IsNullOrEmpty(cleaned) ? null : cleaned;
    }

    // substitute {EffectValueN} placeholders with the row's numeric effect values, then strip tags
    static string CleanPassiveDesc(string raw, Dictionary<string, object> pv)
    {
        string s = Regex.Replace(raw, @"\{EffectValue(\d)\}", m =>
            IntOrRound(F(pv, "EffectValue" + m.Groups[1].Value)).ToString());
        var cleaned = Clean(s);
        return string.IsNullOrEmpty(cleaned) ? null : cleaned;
    }

    // Resolve embedded <itemName id=|X|/> / <characterName id=|Y|/> / <img .../> rich tags in an
    // active-skill description to their English display text (same IdTag scheme as partner descs;
    // no per-rank {templates} here), then strip remaining tags via Clean().
    static string CleanActiveDesc(string raw, Dictionary<string, string> pal, Dictionary<string, string> item,
        Dictionary<string, string> mapobj, Dictionary<string, string> ui, Dictionary<string, string> skill)
    {
        if (raw == null) return null;
        string s = IdTag.Replace(raw, m =>
        {
            var tag = m.Groups[1].Value; var id = m.Groups[2].Value;
            return tag switch
            {
                "itemName" => item.TryGetValue("ITEM_NAME_" + id, out var x) ? x : id,
                "mapObjectName" => mapobj.TryGetValue("MAPOBJECT_NAME_" + id, out var x) ? x : id,
                "characterName" => pal.TryGetValue("PAL_NAME_" + id, out var x) ? x : id,
                "uiCommon" => ui.TryGetValue(id, out var x) ? x : id,
                "img" => "",
                _ => skill.TryGetValue("ACTION_SKILL_" + id, out var x) ? x : id,
            };
        });
        var cleaned = Clean(s);
        return string.IsNullOrEmpty(cleaned) ? null : cleaned;
    }

    // export each distinct partner-skill icon (T_icon_skill_pal_<NNN>) once; return (exported, unresolved ids)
    static (int, List<int>) ExportPartnerIcons(IFileProvider provider, IEnumerable<int> ids)
    {
        var dir = Path.Combine(OutDir, "icons", "partner");
        Directory.CreateDirectory(dir);
        int exported = 0; var unresolved = new List<int>();
        foreach (var id in ids.Distinct().OrderBy(x => x))
        {
            var assetPath = "Pal/Content/Pal/Texture/UI/InGame/SkillIcon/T_icon_skill_pal_" + id.ToString("000");
            try
            {
                if (provider.TryLoadPackageObject(assetPath, out var obj) && obj is UTexture2D tex)
                {
                    using var bmp = tex.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                    if (bmp != null)
                    {
                        using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
                        using var fs = File.Create(Path.Combine(dir, $"{id}.png"));
                        data.SaveTo(fs);
                        exported++;
                        continue;
                    }
                }
                unresolved.Add(id);
            }
            catch { unresolved.Add(id); }
        }
        return (exported, unresolved);
    }

    // `--export-named-partner-icons`: enumerate every bespoke partner-skill icon
    // texture (`T_icon_skill_pal_<Name>`, excluding the numbered `_<NNN>` glyphs
    // handled by ExportPartnerIcons), export each to out/icons/partner-named/<Name>.png,
    // then join by matching the texture-name suffix (case-insensitive, common
    // prefixes stripped) to a `DT_partnerSkillIconDataTable` row key — whose value
    // is the numeric TextureID the pack/UI keys off. On a confident exact match,
    // copy the PNG to app/public/partner/<id>.png so the numeric key resolves.
    //
    // Reality of this build: most bespoke row keys (species names, TextureID 21+)
    // have NO individual texture — the named textures are mostly shared category
    // glyphs plus a few species-specific ones; only the latter join to a row key.
    // No fuzzy number->glyph guessing (no authoritative ordering exists).
    static void ExportNamedPartnerIcons(IFileProvider provider, Dictionary<string, int> iconInfo)
    {
        var namedDir = Path.Combine(OutDir, "icons", "partner-named");
        Directory.CreateDirectory(namedDir);
        var appDir = Path.GetFullPath(Path.Combine(OutDir, "..", "..", "..", "app", "public", "partner"));
        Directory.CreateDirectory(appDir);

        // TextureID -> icon-table row keys (the join keys; a species name resolves
        // to one of these via ResolveVariantKey).
        var idToKeys = new Dictionary<int, List<string>>();
        foreach (var kv in iconInfo)
            if (kv.Value >= 0) (idToKeys.TryGetValue(kv.Value, out var l) ? l : (idToKeys[kv.Value] = new List<string>())).Add(kv.Key);
        // Normalized row-key -> TextureID for suffix matching.
        static string Norm(string s) => Regex.Replace(s.ToLowerInvariant(), @"^(t_icon_skill_pal_|skill_|waza_|partnerskill_)", "");
        var normKeyToId = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var kv in iconInfo)
            if (kv.Value >= 0) normKeyToId[Norm(kv.Key)] = kv.Value;

        // Distinct named textures (basename, prefer .uasset paths).
        var suffixes = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in provider.Files.Keys)
        {
            var fn = Path.GetFileNameWithoutExtension(f);
            if (!fn.StartsWith("T_icon_skill_pal_", StringComparison.OrdinalIgnoreCase)) continue;
            var suffix = fn.Substring("T_icon_skill_pal_".Length);
            if (suffix.Length == 0 || Regex.IsMatch(suffix, @"^\d+$")) continue; // numbered handled elsewhere
            suffixes.Add(suffix);
        }
        Console.WriteLine($"[named-icons] found {suffixes.Count} bespoke T_icon_skill_pal_<Name> textures");

        int exported = 0, matched = 0, copied = 0;
        var manifest = new List<object>();
        foreach (var suffix in suffixes)
        {
            var assetPath = "Pal/Content/Pal/Texture/UI/InGame/SkillIcon/T_icon_skill_pal_" + suffix;
            int? textureId = null; bool didCopy = false; bool didExport = false;
            try
            {
                if (provider.TryLoadPackageObject(assetPath, out var obj) && obj is UTexture2D tex)
                {
                    using var bmp = tex.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                    if (bmp != null)
                    {
                        using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
                        var namedPng = Path.Combine(namedDir, $"{suffix}.png");
                        using (var fs = File.Create(namedPng)) data.SaveTo(fs);
                        exported++; didExport = true;

                        // Confident join: suffix (normalized) == an icon-table row key.
                        if (normKeyToId.TryGetValue(Norm(suffix), out var tid))
                        {
                            textureId = tid; matched++;
                            var appPng = Path.Combine(appDir, $"{tid}.png");
                            if (!File.Exists(appPng)) { File.Copy(namedPng, appPng, false); copied++; didCopy = true; }
                        }
                    }
                }
            }
            catch (Exception e) { Console.WriteLine($"[named-icons] {suffix}: {e.Message}"); }
            manifest.Add(new { name = suffix, texture_id = textureId, exported = didExport, copied = didCopy, row_keys = textureId is int t && idToKeys.TryGetValue(t, out var ks) ? ks : null });
        }

        File.WriteAllText(Path.Combine(namedDir, "index.json"),
            JsonConvert.SerializeObject(new { count = suffixes.Count, exported, matched, copied, textures = manifest }, Formatting.Indented));
        Console.WriteLine($"[named-icons] exported={exported} matchedToTextureId={matched} copiedToApp={copied} (unmatched={suffixes.Count - matched})");
        Console.WriteLine($"[named-icons] app partner dir now has {Directory.GetFiles(appDir, "*.png").Length} PNGs");
    }

    static IDictionary<string, object> ReadGameSettings(IFileProvider provider)
    {
        var res = new Dictionary<string, object>();
        if (!provider.TryLoadPackage("Pal/Content/Pal/Blueprint/System/BP_PalGameSetting", out var pkg))
        {
            Console.WriteLine("[gamesetting] FAILED to load package");
            return res;
        }
        var cdo = pkg.GetExports().FirstOrDefault(e => e.Name.StartsWith("Default__"));
        if (cdo == null) { Console.WriteLine("[gamesetting] no CDO export"); return res; }

        // canonical breeding arrays first (deterministic order)
        AddArray(res, cdo, "Combi_TalentInheritNum", "combi_talent_inherit_num");
        AddArray(res, cdo, "Combi_PassiveInheritNum", "combi_passive_inherit_num");
        AddArray(res, cdo, "Combi_PassiveRandomAddNum", "combi_passive_random_add_num");

        // any other Combi/Talent/Passive/Breed/Inherit scalar or scalar-array props
        foreach (var p in cdo.Properties.OrderBy(p => p.Name.Text, StringComparer.Ordinal))
        {
            var n = p.Name.Text;
            if (!(n.Contains("Combi") || n.Contains("Talent") || n.Contains("Passive") || n.Contains("Breed") || n.Contains("Inherit"))) continue;
            var key = ToSnake(n);
            if (res.ContainsKey(key)) continue;
            var val = p.Tag?.GenericValue;
            if (val is UScriptArray arr)
            {
                var list = arr.Properties.Select(x => Num(x.GenericValue)).Where(x => x != null).ToList();
                if (list.Count == arr.Properties.Count && list.Count > 0) res[key] = list;
            }
            else
            {
                var num = Num(val);
                if (num != null) res[key] = num;
                else if (val is bool bb) res[key] = bb;
            }
        }
        return res;
    }

    static void AddArray(Dictionary<string, object> res, dynamic cdo, string prop, string key)
    {
        var tag = ((IEnumerable<FPropertyTag>)cdo.Properties).FirstOrDefault(p => p.Name.Text == prop);
        if (tag?.Tag?.GenericValue is UScriptArray arr)
            res[key] = arr.Properties.Select(x => Num(x.GenericValue)).ToList();
        else
            res[key] = new List<object>();
    }

    static List<string> ExportElementIcons(IFileProvider provider)
    {
        var elDir = Path.Combine(OutDir, "icons", "elements");
        Directory.CreateDirectory(elDir);
        var variants = new List<string>();

        int tiles = ExportSet(provider, "Pal/Content/Pal/Texture/UI/InGame/T_Icon_element_s_", elDir, "tile");
        if (tiles > 0) variants.Add($"tile({tiles})");
        int glyphs = ExportSet(provider, "Pal/Content/Pal/Texture/UI/Main_Menu/T_Icon_element_", elDir, "glyph");
        if (glyphs > 0) variants.Add($"glyph({glyphs})");
        return variants;
    }

    static int ExportSet(IFileProvider provider, string basePath, string outDir, string suffix)
    {
        int count = 0;
        for (int i = 0; i < IconKinds.Length; i++)
        {
            var assetPath = $"{basePath}{i:00}";
            try
            {
                if (!provider.TryLoadPackageObject(assetPath, out var obj) || obj is not UTexture2D tex) continue;
                using var bmp = tex.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                if (bmp == null) continue;
                using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
                var outPath = Path.Combine(outDir, $"{IconKinds[i]}_{suffix}.png");
                using var fs = File.Create(outPath);
                data.SaveTo(fs);
                count++;
            }
            catch (Exception e) { Console.WriteLine($"[icon] {assetPath} fail: {e.Message}"); }
        }
        return count;
    }

    // ---- helpers ----
    static Dictionary<string, object> Vals(FStructFallback s)
    {
        var d = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in s.Properties) d[p.Name.Text] = p.Tag?.GenericValue;
        return d;
    }
    static bool B(Dictionary<string, object> v, string k) => v.TryGetValue(k, out var o) && o is bool b && b;
    static int I(Dictionary<string, object> v, string k) => v.TryGetValue(k, out var o) && o != null ? Convert.ToInt32(o) : 0;
    static double F(Dictionary<string, object> v, string k) => v.TryGetValue(k, out var o) && o != null ? Convert.ToDouble(o) : 0;
    static string S(Dictionary<string, object> v, string k)
    {
        if (!v.TryGetValue(k, out var o) || o == null) return null;
        return o is FName fn ? fn.Text : o.ToString();
    }
    static string StripEnum(string s) => s == null ? null : (s.Contains("::") ? s.Substring(s.IndexOf("::") + 2) : s);
    static string NonNone(string s) => string.IsNullOrEmpty(s) || s == "None" ? null : s;
    static string ResolvePartnerKey(Dictionary<string, string> table, string overrideKey, string internalName)
    {
        if (overrideKey != null && table.ContainsKey(overrideKey)) return overrideKey;
        var n = internalName;
        while (true)
        {
            var k = "PARTNERSKILL_" + n;
            if (table.ContainsKey(k)) return k;
            var idx = n.LastIndexOf('_');
            if (idx < 0) return null;
            n = n.Substring(0, idx);
        }
    }
    static object Num(object v) => v switch
    {
        null => null,
        int i => i,
        long l => l,
        short sh => (int)sh,
        byte b => (int)b,
        uint u => (long)u,
        float f => IntOrRound(f),
        double d => IntOrRound(d),
        _ => null,
    };
    static object IntOrRound(double d) => d == Math.Floor(d) && Math.Abs(d) < 9.2e18 ? (object)(long)d : Math.Round(d, 5);
    static string ToSnake(string s)
    {
        var t = Regex.Replace(s, "([a-z0-9])([A-Z])", "$1_$2").Replace("__", "_");
        return t.ToLowerInvariant();
    }
    static string Clean(string s)
    {
        if (s == null) return null;
        s = s.Replace("\r\n", "\n").Replace("\r", "\n");
        s = RichTag.Replace(s, "");
        s = Ws.Replace(s, " ");
        s = Regex.Replace(s, @" *\n *", "\n");   // trim spaces around authored line breaks
        s = Regex.Replace(s, @"\n{2,}", "\n");   // collapse blank-line runs
        return s.Trim();
    }

    static Dictionary<string, string> LoadText(IFileProvider p, string path)
    {
        var t = p.LoadPackageObject<UDataTable>(path);
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in t.RowMap)
            d[e.Key.Text] = e.Value.Get<FText>("TextData").Text;
        return d;
    }

    // read a property off an anonymous object (validation convenience)
    static object GetProp(object o, string name) => o?.GetType().GetProperty(name)?.GetValue(o);
}
