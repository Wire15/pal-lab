using System.Text.RegularExpressions;
using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Core.i18N;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.Core.Math;
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
        if (args.Contains("--discover-research")) { DiscoverResearch(provider); return 0; }
        if (args.Contains("--discover-drops")) { DiscoverDrops(provider); return 0; }
        if (args.Contains("--discover-element")) { DiscoverElement(provider); return 0; }
        if (args.Contains("--export-map")) return ExportMap(provider);
        if (args.Contains("--discover-map-icons")) { DiscoverMapIcons(provider); return 0; }
        if (args.Contains("--discover-map-guids")) { DiscoverMapGuids(provider); return 0; }
        if (args.Contains("--export-map-icons")) return ExportMapIcons(provider);

        var monsters = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalMonsterParameter");
        var skillNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_SkillNameText_Common");
        var skillDescs = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_SkillDescText_Common");
        var palNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_PalNameText_Common");
        var firstActRaw = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_PalFirstActivatedInfoText");
        var itemNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_ItemNameText_Common");
        var mapObjNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_MapObjectNameText_Common");
        var uiCommon = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_UI_Common_Text_Common");
        var researchNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_LabResearchText");
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

        // ---- per-species item drops (DT_PalDropItem) ----
        // Row key = CharacterID + zero-padded Level threshold (e.g. `SheepBall000`, `Anubis080`);
        // fields: CharacterID, Level, then 10 slots of ItemId<N>/Rate<N>/min<N>/Max<N>. Rate is a
        // PERCENT (100 => 100%). DT_PalDropItem and DT_PalDropItem_Common are byte-identical in this
        // build (verified via --discover-drops, 0 differing rows); we use DT_PalDropItem. We pick the
        // LOWEST-Level row per CharacterID (the base drop table palpedia displays) and emit only the
        // non-empty slots in order. Item names localize via ITEM_NAME_<ItemId> in DT_ItemNameText_Common
        // (falls back to the raw ItemId — never fabricated). Keyed by species internal name (CharacterID).
        var dropTable = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalDropItem");
        var dropRowByChar = new Dictionary<string, FStructFallback>(StringComparer.OrdinalIgnoreCase);
        var dropLevelByChar = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var dr in dropTable.RowMap)
        {
            var dv = Vals(dr.Value);
            var cid = S(dv, "CharacterID");
            if (string.IsNullOrEmpty(cid)) continue;
            int lvl = I(dv, "Level");
            if (!dropLevelByChar.TryGetValue(cid, out var have) || lvl < have)
            { dropLevelByChar[cid] = lvl; dropRowByChar[cid] = dr.Value; }
        }
        var dropItemMiss = new SortedSet<string>(StringComparer.Ordinal);
        List<object> ResolveDrops(string internalName)
        {
            if (!dropRowByChar.TryGetValue(internalName, out var row)) return new List<object>();
            var dv = Vals(row);
            var list = new List<object>();
            for (int n = 1; n <= 10; n++)
            {
                var itemId = S(dv, "ItemId" + n);
                if (string.IsNullOrEmpty(itemId) || itemId == "None") continue;
                if (!itemNames.TryGetValue("ITEM_NAME_" + itemId, out var itemName) || string.IsNullOrWhiteSpace(itemName))
                { itemName = itemId; dropItemMiss.Add(itemId); }
                list.Add(new
                {
                    item_id = itemId,
                    item_name = Clean(itemName),
                    min = I(dv, "min" + n),
                    max = I(dv, "Max" + n),
                    rate = F(dv, "Rate" + n),
                });
            }
            return list;
        }
        int dropsCovered = 0, dropsEmpty = 0;

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
                // Extended stats (BOSS-row schema): Support (partner-skill support value),
                // CaptureRateCorrect (capture-rate multiplier), ExpRatio (XP-gain multiplier).
                support = I(v, "Support"),
                capture_rate_correct = F(v, "CaptureRateCorrect"),
                exp_ratio = F(v, "ExpRatio"),
            };

            var drops = ResolveDrops(name);
            if (drops.Count > 0) dropsCovered++; else dropsEmpty++;
            species[name] = new { elements, partner_skill = partner, stats, drops };
        }
        Console.WriteLine($"[species] kept={kept} skipped={skipped} partnerCoverage={partnerHit}/{kept}");
        Console.WriteLine($"[drops] table=DT_PalDropItem speciesWithDrops={dropsCovered}/{kept} speciesNoDrops={dropsEmpty} distinctCharacterIDrows={dropRowByChar.Count} unlocalizedItemIds={dropItemMiss.Count}");
        if (dropItemMiss.Count > 0) Console.WriteLine($"[drops unlocalized items] {string.Join(", ", dropItemMiss)}");
        foreach (var probe in new[] { "SheepBall", "ElecPanda", "ThunderDragonMan", "Anubis" })
        {
            if (!species.TryGetValue(probe, out var sp)) continue;
            var ds = (List<object>)GetProp(sp, "drops");
            Console.WriteLine($"[drops sample] {probe}: {string.Join(", ", ds.Select(d => $"{GetProp(d, "item_name")}({GetProp(d, "item_id")}) {GetProp(d, "min")}-{GetProp(d, "max")}@{FmtNum(Convert.ToDouble(GetProp(d, "rate")))}%"))}");
        }
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

        // ---- lab research (Pal Labor Research tree) ----
        // The research-lab tech tree (DT_LabResearchDataTable): work-suitability-gated
        // research nodes that grant a global buff (EffectType). We emit ONLY the
        // breeding-relevant lines (PalEggHatchingSpeed -> incubation_speed, via the shared
        // BreedEffect map), grouped into per-category chains ordered by prerequisite, with
        // cumulative per-rank fractions the UI composes into incubation_reduction. See
        // ExtractLabResearch. Coverage (total rows vs emitted nodes) is printed for audit.
        var (labResearch, labRows, labEmitted) = ExtractLabResearch(provider, researchNames);
        Console.WriteLine($"[lab-research] table=DT_LabResearchDataTable rows={labRows} breeding-relevant nodes emitted={labEmitted} lines={labResearch.Count}");
        foreach (var line in labResearch)
            Console.WriteLine($"    line '{GetProp(line, "id")}' ({GetProp(line, "category")}) name='{GetProp(line, "name")}' effect={GetProp(line, "effect")} values_per_rank=[{string.Join(", ", ((List<double>)GetProp(line, "values_per_rank")).Select(FmtNum))}]");

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
            lab_research = labResearch,
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

        // Drops: coverage + ground-truth spot-check (never fabricated — only real DT_PalDropItem rows).
        Gate(dropsCovered >= 250, $"drops coverage {dropsCovered} unexpectedly low");
        object DropOf(object sp, string itemId)
        {
            var ds = sp == null ? null : (List<object>)GetProp(sp, "drops");
            return ds?.FirstOrDefault(d => (string)GetProp(d, "item_id") == itemId);
        }
        // Lamball (SheepBall) drops Wool 1-3 @100% (starter ground truth).
        var sheepDrop = lamball == null ? null : DropOf(lamball, "Wool");
        Gate(sheepDrop != null, "Lamball (SheepBall) missing Wool drop");
        if (sheepDrop != null)
        {
            Gate((int)GetProp(sheepDrop, "min") == 1 && (int)GetProp(sheepDrop, "max") == 3,
                $"Lamball Wool range {GetProp(sheepDrop, "min")}-{GetProp(sheepDrop, "max")} != 1-3");
            Gate(Convert.ToDouble(GetProp(sheepDrop, "rate")) == 100.0,
                $"Lamball Wool rate {GetProp(sheepDrop, "rate")} != 100");
        }
        // Every drop row must be monotonic (min<=max) and carry a positive rate.
        int badDrop = 0; string badDropSample = null;
        foreach (var kv in species)
            foreach (var d in (List<object>)GetProp(kv.Value, "drops"))
            {
                int dmin = (int)GetProp(d, "min"), dmax = (int)GetProp(d, "max");
                double drate = Convert.ToDouble(GetProp(d, "rate"));
                if (dmin > dmax || dmin < 0 || drate <= 0 || drate > 100)
                { badDrop++; badDropSample ??= $"{kv.Key}:{GetProp(d, "item_id")} {dmin}-{dmax}@{drate}"; }
            }
        Gate(badDrop == 0, $"{badDrop} drop rows fail monotonic/rate sanity (e.g. {badDropSample})");

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

        // lab research: every emitted line is an incubation-speed chain with a monotonic
        // cumulative curve; both known PalEggHatchingSpeed branches (EmitFlame/Cool) resolve
        // to a 4-rank chain ending at +30%. This is the validation set for the discovery.
        object FindLine(string id) => labResearch.FirstOrDefault(l => (string)GetProp(l, "id") == id);
        Gate(labResearch.Count >= 1, "lab_research emitted no lines");
        foreach (var l in labResearch)
        {
            Gate((string)GetProp(l, "effect") == "incubation_speed", $"lab line {GetProp(l, "id")} effect != incubation_speed");
            var vs = (List<double>)GetProp(l, "values_per_rank");
            Gate(vs.Count >= 1 && vs.SequenceEqual(vs.OrderBy(x => x)) && vs.First() > 0,
                $"lab line {GetProp(l, "id")} values [{string.Join(",", vs.Select(FmtNum))}] not positive-monotonic");
        }
        foreach (var id in new[] { "EmitFlame", "Cool" })
        {
            var line = FindLine(id);
            Gate(line != null, $"lab research {id} incubation line missing");
            if (line == null) continue;
            var vs = (List<double>)GetProp(line, "values_per_rank");
            Gate(vs.Count == 4, $"lab line {id} expected 4 ranks, got {vs.Count}");
            Gate(vs.Count == 4 && Math.Abs(vs[0] - 0.05) < 1e-6 && Math.Abs(vs.Last() - 0.30) < 1e-6,
                $"lab line {id} range [{string.Join(",", vs.Select(FmtNum))}] != [0.05..0.30]");
        }

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

    static List<string> LayerNamesOf(Dictionary<string, object> v)
    {
        var res = new List<string>();
        if (v.TryGetValue("LayerNames", out var o) && o is CUE4Parse.UE4.Assets.Objects.UScriptArray arr)
            foreach (var p in arr.Properties)
            {
                var g = p.GenericValue;
                var t = g is FName fn ? fn.Text : g?.ToString();
                if (!string.IsNullOrEmpty(t) && t != "None") res.Add(t);
            }
        return res;
    }

    // ---- MAP EXTRACTION (--export-map) ----------------------------------------------------------
    // Emits app/public/map/{worldmap.webp,treemap.webp,map-data.json} per Wave-1 contract C1:
    //   (a) T_WorldMap/T_TreeMap -> 8192x8192 lossy WebP (q85, asserted <=10MB each)
    //   (b) DT_WorldMapUIData bounds/mask sizes (single source of truth; never hardcoded)
    //   (c) DT_PalSpawnerPlacement x DT_PalWildSpawner spawn points (join on wild.SpawnerName field)
    //   (d) DT_BossSpawnerLoactionData bosses
    //   (e) World-Partition actor sweep (MainWorld_5) for Relic effigies + Tower fast-travel points,
    //       each resolved via its OWN RootComponent(FPackageIndex)->RelativeLocation
    // then empirically calibrates the world->pixel axis orientation and writes the formula verbatim.
    sealed class MapLayer
    {
        public double Xmin, Ymin, Xmax, Ymax;
        public int MaskW, MaskH, ImgW, ImgH;
        public string Image;
        public bool Contains(double x, double y) => x >= Xmin && x <= Xmax && y >= Ymin && y <= Ymax;
    }

    static int ExportMap(IFileProvider provider)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var mapDir = Path.GetFullPath(Path.Combine(OutDir, "..", "..", "..", "app", "public", "map"));
        var probeDir = Path.GetFullPath(Path.Combine(OutDir, "..", "..", "..", "testdata", "probe"));
        Directory.CreateDirectory(mapDir);

        // ---- (b) DT_WorldMapUIData: world bounds + mask sizes ----
        var mapUi = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/WorldMapUIData/DT_WorldMapUIData");
        var layers = new Dictionary<string, MapLayer>(StringComparer.Ordinal);
        foreach (var r in mapUi.RowMap)
        {
            var min = r.Value.GetOrDefault<FVector>("landScapeRealPositionMin");
            var max = r.Value.GetOrDefault<FVector>("landScapeRealPositionMax");
            var mask = r.Value.GetOrDefault<FVector2D>("MaskTextureSize");
            layers[r.Key.Text] = new MapLayer { Xmin = min.X, Ymin = min.Y, Xmax = max.X, Ymax = max.Y, MaskW = (int)mask.X, MaskH = (int)mask.Y };
            Console.WriteLine($"[map-ui] {r.Key.Text} worldMin=({min.X},{min.Y}) worldMax=({max.X},{max.Y}) mask={(int)mask.X}x{(int)mask.Y}");
        }
        if (!layers.TryGetValue("MainMap", out var main) || !layers.TryGetValue("Tree", out var tree))
        { Console.WriteLine("[export-map] FAIL: DT_WorldMapUIData missing MainMap/Tree rows"); return 1; }
        main.Image = "/map/worldmap.webp";
        tree.Image = "/map/treemap.webp";

        // ---- (a) textures -> webp (keep worldBmp for calibration) ----
        SKBitmap worldBmp = DecodeMapTexture(provider, "Pal/Content/Pal/Texture/UI/Map/T_WorldMap");
        SKBitmap treeBmp = DecodeMapTexture(provider, "Pal/Content/Pal/Texture/UI/Map/T_TreeMap");
        if (worldBmp == null || treeBmp == null) { Console.WriteLine("[export-map] FAIL: map texture decode returned null"); return 1; }
        main.ImgW = worldBmp.Width; main.ImgH = worldBmp.Height;
        tree.ImgW = treeBmp.Width; tree.ImgH = treeBmp.Height;
        long worldWebp = EncodeWebp(worldBmp, Path.Combine(mapDir, "worldmap.webp"), 85);
        long treeWebp = EncodeWebp(treeBmp, Path.Combine(mapDir, "treemap.webp"), 85);
        Console.WriteLine($"[map-tex] worldmap.webp {worldBmp.Width}x{worldBmp.Height} {worldWebp / 1024 / 1024.0:F2}MB; treemap.webp {treeBmp.Width}x{treeBmp.Height} {treeWebp / 1024 / 1024.0:F2}MB");
        treeBmp.Dispose();

        // ---- (c) spawns: DT_PalSpawnerPlacement x DT_PalWildSpawner ----
        var monsters = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalMonsterParameter");
        var palIds = new HashSet<string>(monsters.RowMap.Select(r => r.Key.Text), StringComparer.OrdinalIgnoreCase);
        var placement = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Spawner/DT_PalSpawnerPlacement");
        var wild = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Spawner/DT_PalWildSpawner");
        // group wild rows by their SpawnerName field (the group key placements join to)
        var wildByField = new Dictionary<string, List<FStructFallback>>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in wild.RowMap)
        {
            var f = S(Vals(r.Value), "SpawnerName");
            if (!string.IsNullOrEmpty(f)) (wildByField.TryGetValue(f, out var l) ? l : (wildByField[f] = new List<FStructFallback>())).Add(r.Value);
        }
        // aggregate spawn points: key (species, xInt, yInt, time, weather, boss) -> level/count ranges
        var spawnAgg = new Dictionary<(string, int, int, string, string, bool), int[]>(); // [lvMin,lvMax,nMin,nMax,r]
        int joinMiss = 0, palUnknown = 0; var palUnknownSamples = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var pr in placement.RowMap)
        {
            var pv = Vals(pr.Value);
            var sn = S(pv, "SpawnerName");
            List<FStructFallback> group = null;
            if (sn != null && wildByField.TryGetValue(sn, out var g0)) group = g0;
            else foreach (var ln in LayerNamesOf(pv))
            {
                var strip = ln.StartsWith("EnemySpawner_", StringComparison.OrdinalIgnoreCase) ? ln.Substring("EnemySpawner_".Length) : ln;
                if (wildByField.TryGetValue(strip, out var g1)) { group = g1; break; }
            }
            if (group == null) { joinMiss++; continue; }
            var loc = pr.Value.GetOrDefault<FVector>("Location");
            int px = (int)Math.Round(loc.X), py = (int)Math.Round(loc.Y);
            int radius = (int)Math.Round(F(pv, "StaticRadius"));
            foreach (var wr in group)
            {
                var wv = Vals(wr);
                bool boss = string.Equals(StripEnum(S(wv, "SpawnerType")), "FieldBoss", StringComparison.OrdinalIgnoreCase);
                var time = NormTime(S(wv, "OnlyTime"));
                var weather = NormWeather(S(wv, "OnlyWeather"));
                for (int n = 1; n <= 3; n++)
                {
                    var pal = S(wv, "Pal_" + n);
                    if (string.IsNullOrEmpty(pal) || pal == "None") continue;          // NPC-only / empty slot
                    if (!palIds.Contains(pal)) { palUnknown++; if (palUnknownSamples.Count < 30) palUnknownSamples.Add(pal); continue; } // RowName / junk
                    int lvMin = I(wv, "LvMin_" + n), lvMax = I(wv, "LvMax_" + n);
                    int nMin = I(wv, "NumMin_" + n), nMax = I(wv, "NumMax_" + n);
                    var key = (pal, px, py, time, weather, boss);
                    if (spawnAgg.TryGetValue(key, out var a))
                    { a[0] = Math.Min(a[0], lvMin); a[1] = Math.Max(a[1], lvMax); a[2] = Math.Min(a[2], nMin); a[3] = Math.Max(a[3], nMax); a[4] = Math.Max(a[4], radius); }
                    else spawnAgg[key] = new[] { lvMin, lvMax, nMin, nMax, radius };
                }
            }
        }
        Console.WriteLine($"[spawns] placements={placement.RowMap.Count} joinMiss={joinMiss} wildGroups={wildByField.Count} aggregatedPoints={spawnAgg.Count} palUnknownSlots={palUnknown}");
        if (palUnknownSamples.Count > 0) Console.WriteLine($"[spawns] non-species Pal values skipped: {string.Join(", ", palUnknownSamples)}");

        // ---- (d) bosses: DT_BossSpawnerLoactionData ----
        var bossTable = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/UI/DT_BossSpawnerLoactionData");
        var bosses = new List<(string species, double x, double y, int level)>();
        int bossEmptyCid = 0; var bossEmptySamples = new List<string>();
        foreach (var r in bossTable.RowMap)
        {
            var v = Vals(r.Value);
            var cid = S(v, "CharacterID");
            if (string.IsNullOrEmpty(cid) || cid == "None") { bossEmptyCid++; if (bossEmptySamples.Count < 8) bossEmptySamples.Add(S(v, "SpawnerID") ?? r.Key.Text); continue; }
            var loc = r.Value.GetOrDefault<FVector>("Location");
            bosses.Add((cid, loc.X, loc.Y, I(v, "Level")));
        }
        Console.WriteLine($"[bosses] rows={bossTable.RowMap.Count} emitted={bosses.Count} emptyCharacterID={bossEmptyCid} distinctSpecies={bosses.Select(b => b.species).Distinct().Count()}");
        if (bossEmptySamples.Count > 0) Console.WriteLine($"[bosses] empty-CID SpawnerIDs (sample): {string.Join(", ", bossEmptySamples)}");

        // ---- (e) actor sweep: Relic effigies + Tower fast-travel points ----
        var ftNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_MapRespawnPointInfoText");
        var effigies = new List<(double x, double y, double z, string guid)>();
        var fastTravel = new List<(double x, double y, string name, string guid)>();
        var effigySeen = new HashSet<(long, long, long)>();
        var ftSeen = new HashSet<(long, long, long)>();
        int cellsSwept = 0, relicNoRoot = 0, ftNoRoot = 0, effigyDup = 0, ftDup = 0, ftNameHit = 0;
        var mapCells = provider.Files.Values
            .Where(f => f.Path.EndsWith(".umap", StringComparison.OrdinalIgnoreCase)
                && f.Path.Contains("Pal/Content/Pal/Maps/MainWorld_5/", StringComparison.OrdinalIgnoreCase))
            .ToList();
        foreach (var gf in mapCells)
        {
            cellsSwept++;
            if (!provider.TryLoadPackage(gf, out var pkg)) continue;
            for (int i = 0; i < pkg.ExportMapLength; i++)
            {
                var ptr = new FPackageIndex(pkg, i + 1).ResolvedObject;
                var cls = ptr?.Class?.Name.Text;
                bool isRelic = cls == "BP_LevelObject_Relic_C";
                bool isFt = cls == "BP_LevelObject_TowerFastTravelPoint_C";
                if (!isRelic && !isFt) continue;
                var actor = ptr.Object?.Value;
                if (actor == null) continue;
                var rootIdx = actor.GetOrDefault<FPackageIndex>("RootComponent");
                var comp = rootIdx != null && rootIdx.IsExport ? rootIdx.Load() : null;
                if (comp == null) { if (isRelic) relicNoRoot++; else ftNoRoot++; continue; }
                var loc = comp.GetOrDefault("RelativeLocation", new FVector());
                var dedupe = ((long)Math.Round(loc.X * 10), (long)Math.Round(loc.Y * 10), (long)Math.Round(loc.Z * 10));
                // World-static actor instance GUID: matches the player save's
                // FastTravelPointUnlockFlag / RelicObtainForInstanceFlag map keys when formatted as
                // UE Digits (verified 8/9 FT + 5/5 effigy vs testdata/probe/coop-Player-host.sav).
                var iid = actor.GetOrDefault<FGuid>("LevelObjectInstanceId");
                string guid = (iid.A | iid.B | iid.C | iid.D) != 0 ? UeDigits(iid) : null;
                if (isRelic)
                {
                    if (!effigySeen.Add(dedupe)) { effigyDup++; continue; }
                    effigies.Add((loc.X, loc.Y, loc.Z, guid));
                }
                else
                {
                    if (!ftSeen.Add(dedupe)) { ftDup++; continue; }
                    var id = actor.GetOrDefault<FName>("FastTravelPointID").Text;
                    string name = null;
                    if (!string.IsNullOrEmpty(id) && id != "None" && ftNames.TryGetValue(id, out var raw)) { name = Clean(raw); if (!string.IsNullOrEmpty(name)) ftNameHit++; else name = null; }
                    fastTravel.Add((loc.X, loc.Y, name, guid));
                }
            }
        }
        Console.WriteLine($"[actors] cellsSwept={cellsSwept} effigies={effigies.Count} (dup={effigyDup} noRoot={relicNoRoot}) fastTravel={fastTravel.Count} (dup={ftDup} noRoot={ftNoRoot}) ftNamesResolved={ftNameHit}/{fastTravel.Count} ({sw.Elapsed.TotalSeconds:F0}s)");

        // ---- calibration: pick world->pixel axis orientation empirically ----
        var calPts = new List<(double x, double y)>();
        foreach (var b in bosses) if (main.Contains(b.x, b.y)) calPts.Add((b.x, b.y));
        foreach (var f in fastTravel) if (main.Contains(f.x, f.y)) calPts.Add((f.x, f.y));
        foreach (var e in effigies) if (main.Contains(e.x, e.y)) calPts.Add((e.x, e.y));
        (bool uIsY, bool uFlip, bool vFlip) best = default; double bestScore = -1, secondScore = -1;
        Console.WriteLine($"[calibrate] scoring {calPts.Count} MainMap points across 8 orientations (land-hit fraction):");
        foreach (var uIsY in new[] { true, false })
            foreach (var uFlip in new[] { false, true })
                foreach (var vFlip in new[] { false, true })
                {
                    int hit = 0;
                    foreach (var (x, y) in calPts)
                    {
                        var (fx, fy) = Project(uIsY, uFlip, vFlip, main, x, y);
                        int ix = (int)fx, iy = (int)fy;
                        if (ix < 0 || iy < 0 || ix >= main.ImgW || iy >= main.ImgH) continue;
                        if (IsLand(worldBmp.GetPixel(ix, iy))) hit++;
                    }
                    double score = calPts.Count > 0 ? (double)hit / calPts.Count : 0;
                    Console.WriteLine($"    uIsY={uIsY} uFlip={uFlip} vFlip={vFlip} -> {score:P1}");
                    if (score > bestScore) { secondScore = bestScore; bestScore = score; best = (uIsY, uFlip, vFlip); }
                    else if (score > secondScore) secondScore = score;
                }
        Console.WriteLine($"[calibrate] WINNER uIsY={best.uIsY} uFlip={best.uFlip} vFlip={best.vFlip} landHit={bestScore:P1} (runner-up {secondScore:P1}, separation {bestScore / Math.Max(secondScore, 0.001):F2}x)");
        var formula = BuildFormula(best.uIsY, best.uFlip, best.vFlip);
        Console.WriteLine($"[calibrate] world_to_px = {formula}");
        RenderCalibration(worldBmp, main, best, bosses, fastTravel, effigies, Path.Combine(probeDir, "calibration.png"));
        worldBmp.Dispose();

        // ---- assign every point to a map layer (Tree first: more specific), build JSON ----
        int droppedOutside = 0;
        string AssignMap(double x, double y)
        {
            if (tree.Contains(x, y)) return "Tree";
            if (main.Contains(x, y)) return "MainMap";
            return null;
        }
        // spawns grouped by (species, map)
        var spawnsBySpeciesMap = new SortedDictionary<(string, string), List<object>>(Comparer<(string, string)>.Create((a, b) =>
        {
            int c = string.CompareOrdinal(a.Item1, b.Item1); return c != 0 ? c : string.CompareOrdinal(a.Item2, b.Item2);
        }));
        foreach (var kv in spawnAgg)
        {
            var (species, x, y, time, weather, boss) = kv.Key;
            var m = AssignMap(x, y);
            if (m == null) { droppedOutside++; continue; }
            var a = kv.Value;
            (spawnsBySpeciesMap.TryGetValue((species, m), out var lst) ? lst : (spawnsBySpeciesMap[(species, m)] = new List<object>()))
                .Add(new { x, y, r = a[4], lv = new[] { a[0], a[1] }, n = new[] { a[2], a[3] }, time, weather, boss });
        }
        var spawnsOut = new List<object>();
        foreach (var kv in spawnsBySpeciesMap)
        {
            var pts = kv.Value.OrderBy(p => (int)GetProp(p, "x")).ThenBy(p => (int)GetProp(p, "y")).ToList();
            spawnsOut.Add(new { species = kv.Key.Item1, map = kv.Key.Item2, points = pts });
        }
        var bossesOut = new List<object>();
        int bossDropped = 0;
        foreach (var b in bosses.OrderBy(b => b.species, StringComparer.Ordinal).ThenBy(b => (int)Math.Round(b.x)).ThenBy(b => (int)Math.Round(b.y)))
        {
            var m = AssignMap(b.x, b.y);
            if (m == null) { bossDropped++; continue; }
            bossesOut.Add(new { species = b.species, x = Math.Round(b.x, 3), y = Math.Round(b.y, 3), level = b.level, map = m });
        }
        var effigiesOut = new List<object>();
        int effigyDropped = 0;
        foreach (var e in effigies.OrderBy(e => (int)Math.Round(e.x)).ThenBy(e => (int)Math.Round(e.y)))
        {
            var m = AssignMap(e.x, e.y);
            if (m == null) { effigyDropped++; continue; }
            effigiesOut.Add(new { x = Math.Round(e.x, 3), y = Math.Round(e.y, 3), z = Math.Round(e.z, 3), map = m, guid = e.guid });
        }
        var ftOut = new List<object>();
        int ftDropped = 0;
        foreach (var f in fastTravel.OrderBy(f => (int)Math.Round(f.x)).ThenBy(f => (int)Math.Round(f.y)))
        {
            var m = AssignMap(f.x, f.y);
            if (m == null) { ftDropped++; continue; }
            ftOut.Add(new { x = Math.Round(f.x, 3), y = Math.Round(f.y, 3), map = m, name = f.name, guid = f.guid });
        }
        Console.WriteLine($"[assign] spawnsDroppedOutside={droppedOutside} bossDropped={bossDropped} effigyDropped={effigyDropped} ftDropped={ftDropped}");

        object MapMeta(MapLayer L) => new
        {
            image = L.Image,
            px = new[] { L.ImgW, L.ImgH },
            world_min = new[] { L.Xmin, L.Ymin },
            world_max = new[] { L.Xmax, L.Ymax },
            mask_px = new[] { L.MaskW, L.MaskH },
            world_to_px = formula,
        };
        var root = new
        {
            meta = new { game_build = GameBuild, extracted_at = DateTimeOffset.UtcNow.ToString("o"), usmap = UsmapSource },
            maps = new Dictionary<string, object> { ["MainMap"] = MapMeta(main), ["Tree"] = MapMeta(tree) },
            spawns = spawnsOut,
            bosses = bossesOut,
            effigies = effigiesOut,
            fast_travel = ftOut,
        };
        var outPath = Path.Combine(mapDir, "map-data.json");
        File.WriteAllText(outPath, JsonConvert.SerializeObject(root, Formatting.None));
        Console.WriteLine($"[write] {outPath} ({new FileInfo(outPath).Length / 1024.0:F0}KB)");

        // ---- validation gates ----
        var errors = new List<string>();
        void Gate(bool ok, string msg) { if (!ok) errors.Add(msg); }
        Gate(worldWebp <= 10 * 1024 * 1024, $"worldmap.webp {worldWebp / 1024 / 1024.0:F2}MB > 10MB");
        Gate(treeWebp <= 10 * 1024 * 1024, $"treemap.webp {treeWebp / 1024 / 1024.0:F2}MB > 10MB");
        Gate(main.ImgW == 8192 && main.ImgH == 8192, $"worldmap not 8192x8192 ({main.ImgW}x{main.ImgH})");
        Gate(tree.ImgW == 8192 && tree.ImgH == 8192, $"treemap not 8192x8192 ({tree.ImgW}x{tree.ImgH})");
        Gate(spawnsOut.Count > 0 && spawnAgg.Count > 5000, $"spawns unexpectedly low (groups={spawnsOut.Count} pts={spawnAgg.Count})");
        Gate(bosses.Count + bossEmptyCid == bossTable.RowMap.Count, $"boss row accounting mismatch (emitted={bosses.Count} emptyCID={bossEmptyCid} rows={bossTable.RowMap.Count})");
        Gate(bossesOut.Count >= 85, $"bosses low ({bossesOut.Count})");
        Gate(effigiesOut.Count >= 100, $"effigies low ({effigiesOut.Count})");
        Gate(ftOut.Count >= 40, $"fast_travel low ({ftOut.Count})");
        // orientation is confirmed by land-hit dominance over the other 7 candidates (my IsLand heuristic
        // under-counts coastal/shallow-water spawns, so the absolute fraction is not 100%); cross-validated
        // visually in calibration.png and against SaveSide's fog texture (u=worldY, v=worldX, v-flipped).
        Gate(bestScore >= 0.5 && bestScore >= 1.4 * secondScore, $"calibration ambiguous: winner {bestScore:P1} vs runner-up {secondScore:P1} (need >=50% and >=1.4x)");
        // ground-truth spot check: BOSS_Horus_Water at X=-867560.875 Y=-441338.219 Lv66 must appear
        var horus = bossesOut.FirstOrDefault(b => (string)GetProp(b, "species") == "BOSS_Horus_Water");
        Gate(horus != null, "BOSS_Horus_Water missing from bosses");
        if (horus != null)
        {
            Gate(Math.Abs((double)GetProp(horus, "x") - (-867560.875)) < 1 && Math.Abs((double)GetProp(horus, "y") - (-441338.219)) < 1,
                $"BOSS_Horus_Water coords ({GetProp(horus, "x")},{GetProp(horus, "y")}) != (-867560.875,-441338.219)");
            Gate((int)GetProp(horus, "level") == 66, $"BOSS_Horus_Water level {GetProp(horus, "level")} != 66");
            Gate((string)GetProp(horus, "map") == "MainMap", $"BOSS_Horus_Water map {GetProp(horus, "map")} != MainMap");
        }
        // a known fast-travel name must resolve
        Gate(ftOut.Any(f => (string)GetProp(f, "name") == "Rotmist Root"), "fast_travel 'Rotmist Root' (WorldTree_MiddleBoss_1) not resolved");
        // a known species must have spawn points (Lamball = SheepBall)
        Gate(spawnsOut.Any(s => (string)GetProp(s, "species") == "SheepBall"), "no SheepBall spawn points");
        // GUID emission + empirical host-player join gate (R1): every FT/effigy actor must carry an
        // instance GUID, and the emitted GUIDs must string-match the host player's unlock-flag keys.
        // testdata/probe/coop-Player-host.sav has 9 FT + 5 effigy flag GUIDs; require >=1 match each.
        var ftGuidSet = new HashSet<string>(ftOut.Select(f => (string)GetProp(f, "guid")).Where(g => g != null), StringComparer.OrdinalIgnoreCase);
        var effigyGuidSet = new HashSet<string>(effigiesOut.Select(e => (string)GetProp(e, "guid")).Where(g => g != null), StringComparer.OrdinalIgnoreCase);
        int ftGuidNull = ftOut.Count(f => GetProp(f, "guid") == null);
        int effigyGuidNull = effigiesOut.Count(e => GetProp(e, "guid") == null);
        int ftGuidMatch = GuidGroundTruth.Take(9).Count(ftGuidSet.Contains);
        int effigyGuidMatch = GuidGroundTruth.Skip(9).Count(effigyGuidSet.Contains);
        Gate(ftGuidNull == 0, $"fast_travel entries missing guid ({ftGuidNull}/{ftOut.Count})");
        Gate(effigyGuidNull == 0, $"effigy entries missing guid ({effigyGuidNull}/{effigiesOut.Count})");
        Gate(ftGuidMatch >= 1, "no fast_travel guid matched host-player flags (0/9)");
        Gate(effigyGuidMatch >= 1, "no effigy guid matched host-player flags (0/5)");

        Console.WriteLine("==== MAP SUMMARY ====");
        Console.WriteLine($"species with spawns={spawnsOut.Select(s => (string)GetProp(s, "species")).Distinct().Count()} spawnEntries(species x map)={spawnsOut.Count} totalPoints={spawnsOut.Sum(s => ((List<object>)GetProp(s, "points")).Count)}");
        Console.WriteLine($"bosses={bossesOut.Count} effigies={effigiesOut.Count} fast_travel={ftOut.Count} (named={ftNameHit})");
        Console.WriteLine($"guids: fast_travel host-flag match={ftGuidMatch}/9 (of {ftOut.Count} emitted, {ftGuidNull} null); effigy match={effigyGuidMatch}/5 (of {effigiesOut.Count} emitted, {effigyGuidNull} null)");
        Console.WriteLine($"webp: worldmap={worldWebp / 1024 / 1024.0:F2}MB treemap={treeWebp / 1024 / 1024.0:F2}MB");
        Console.WriteLine($"world_to_px: {formula}");
        Console.WriteLine($"wall={sw.Elapsed.TotalSeconds:F0}s");
        if (errors.Count > 0)
        {
            Console.WriteLine("==== VALIDATION FAILED ====");
            foreach (var e in errors) Console.WriteLine("  FAIL: " + e);
            return 1;
        }
        Console.WriteLine("==== ALL MAP GATES PASSED ====");
        return 0;
    }

    // Reusable discovery pass (`--discover-map-icons`): enumerate every UI texture asset whose
    // path/name hints at map/compass/marker/POI iconography, decode each, record dimensions, and
    // export a native-res PNG thumbnail to testdata/probe/mapicons/ so the map-icon key->asset
    // mapping can be established by eyeballing real art (never guessed). Also dumps the custom
    // marker icon-type enum (EPal*IconType / *CustomMarker*) from the usmap + any icon DataTable.
    static void DiscoverMapIcons(IFileProvider provider)
    {
        var probeDir = Path.GetFullPath(Path.Combine(OutDir, "..", "..", "..", "testdata", "probe"));
        var iconProbe = Path.Combine(probeDir, "mapicons");
        Directory.CreateDirectory(iconProbe);
        // Broad path/name filters: map/compass/marker UI trees + POI icon name tokens.
        var pathRx = new Regex(@"UI/.*(Map|Compass|Marker)", RegexOptions.IgnoreCase);
        var nameRx = new Regex(@"(MapIcon|CompassIcon|Compass_|Marker|Bounty|Wanted|Hunter|FastTravel|Fast_Travel|Dungeon|Tower|Relic|Effigy|Boss|Alpha|Dungeon|BaseCamp|Waypoint|POI|Pin|Objective|Quest)", RegexOptions.IgnoreCase);
        var cands = provider.Files.Keys
            .Where(f => f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Where(f => f.Contains("/Texture/", StringComparison.OrdinalIgnoreCase)
                && (pathRx.IsMatch(f) || nameRx.IsMatch(Path.GetFileNameWithoutExtension(f))))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        Console.WriteLine($"[map-icons] {cands.Count} candidate texture assets (writing testdata/probe/mapicons.log + PNG thumbs)");
        var log = new System.Text.StringBuilder();
        log.AppendLine($"# map-icon texture candidates (build {GameBuild}); {cands.Count} matches");
        log.AppendLine("# <w>x<h>  <status>  <asset-path>  -> <probe-png>");
        int exported = 0, tooBig = 0, notTex = 0;
        foreach (var f in cands)
        {
            var pkgPath = f.Substring(0, f.Length - ".uasset".Length);
            try
            {
                if (!provider.TryLoadPackageObject(pkgPath, out var o) || o is not UTexture2D tex)
                { notTex++; log.AppendLine($"  --x--   not-a-texture  {pkgPath}"); continue; }
                int w = tex.PlatformData.SizeX, h = tex.PlatformData.SizeY;
                // skip the giant map/mask textures; icons are small
                if (w > 1024 || h > 1024) { tooBig++; log.AppendLine($"  {w}x{h}  skip-large  {pkgPath}"); continue; }
                using var bmp = tex.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                if (bmp == null) { log.AppendLine($"  {w}x{h}  decode-null  {pkgPath}"); continue; }
                // flatten path to a unique, readable filename
                var rel = pkgPath.Contains("/Texture/", StringComparison.OrdinalIgnoreCase)
                    ? pkgPath.Substring(pkgPath.IndexOf("/Texture/", StringComparison.OrdinalIgnoreCase) + "/Texture/".Length)
                    : Path.GetFileNameWithoutExtension(pkgPath);
                var flat = rel.Replace('/', '_');
                var png = Path.Combine(iconProbe, flat + ".png");
                using (var data = bmp.Encode(SKEncodedImageFormat.Png, 100))
                using (var fs = File.Create(png)) data.SaveTo(fs);
                exported++;
                log.AppendLine($"  {bmp.Width}x{bmp.Height}  ok  {pkgPath}  -> mapicons/{flat}.png");
            }
            catch (Exception e) { log.AppendLine($"  --x--   error:{e.Message}  {pkgPath}"); }
        }
        log.AppendLine($"# exported={exported} tooBig={tooBig} notTexture={notTex}");
        File.WriteAllText(Path.Combine(probeDir, "mapicons.log"), log.ToString());
        Console.WriteLine($"[map-icons] exported={exported} tooBig(skipped)={tooBig} notTexture={notTex}");

        // ---- custom-marker icon-type enum ----
        DumpMarkerEnum(provider);
    }

    // Locate + dump the custom-marker icon-type enum (players' placeable map-marker palette).
    // Searches the usmap-provided enums for CustomMarker/IconType names, printing ordinal->name
    // so marker_<int> texture keying can be established from data (never guessed).
    static void DumpMarkerEnum(IFileProvider provider)
    {
        try
        {
            var enums = provider.MappingsForGame?.Enums;
            if (enums == null) { Console.WriteLine("[marker-enum] no usmap enums available"); return; }
            var probeDir = Path.GetFullPath(Path.Combine(OutDir, "..", "..", "..", "testdata", "probe"));
            Directory.CreateDirectory(probeDir);
            // dump EVERY enum (name + ordinal->value) to a log so the marker enum can be found by grep
            var all = new System.Text.StringBuilder();
            all.AppendLine($"# {enums.Count} usmap enums (build {GameBuild})");
            foreach (var kv in enums.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                all.AppendLine($"ENUM {kv.Key} ({kv.Value.Count})");
                foreach (var e in kv.Value.OrderBy(x => x.Key)) all.AppendLine($"  {e.Key} = {e.Value}");
            }
            File.WriteAllText(Path.Combine(probeDir, "enums.log"), all.ToString());
            Console.WriteLine($"[marker-enum] wrote testdata/probe/enums.log ({enums.Count} enums)");
            // print candidates whose NAME hints at the marker palette (there is no such enum in the
            // current usmap — IconType is a raw i32 index into T_icon_compass_00..16 — so this is the
            // negative evidence backing the ordinal marker mapping).
            var nameTok = new[] { "Marker", "IconType", "Compass", "MapObjectIcon" };
            int shown = 0;
            foreach (var kv in enums.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                if (!nameTok.Any(t => kv.Key.Contains(t, StringComparison.OrdinalIgnoreCase))) continue;
                shown++;
                Console.WriteLine($"  ENUM {kv.Key} ({kv.Value.Count}):");
                foreach (var e in kv.Value.OrderBy(x => x.Key)) Console.WriteLine($"    {e.Key} = {e.Value}");
            }
            Console.WriteLine($"[marker-enum] matched {shown} candidate enums");
        }
        catch (Exception e) { Console.WriteLine($"[marker-enum] failed: {e.Message}"); }
        // No usmap enum backs IconType (it's a plain IntProperty). Locate the marker widget/BP/DataTable
        // assets that consume IconType so the int->texture linkage can be confirmed (not guessed).
        try
        {
            var hits = provider.Files.Keys
                .Where(f => (f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".umap", StringComparison.OrdinalIgnoreCase))
                    && Path.GetFileNameWithoutExtension(f).Contains("CustomMarker", StringComparison.OrdinalIgnoreCase))
                .OrderBy(x => x, StringComparer.Ordinal).ToList();
            Console.WriteLine($"[marker-files] {hits.Count} assets with 'CustomMarker' in name:");
            foreach (var h in hits) Console.WriteLine("    " + h);
        }
        catch (Exception e) { Console.WriteLine($"[marker-files] failed: {e.Message}"); }
    }

    // ---- GUID DISCOVERY (`--discover-map-guids`) ------------------------------------------------
    // Dumps every GUID-typed value found on a handful of sample BP_LevelObject_Relic_C /
    // BP_LevelObject_TowerFastTravelPoint_C actors (actor props + RootComponent props, recursively)
    // formatted as UE `Digits` (four LE uint32 groups, upper-hex), and flags any that match the
    // host player's known unlock-flag keys. This is how the actor-instance-GUID <-> save-flag-key
    // linkage was established (never guessed); once confirmed, --export-map emits the winning source.
    static readonly string[] GuidGroundTruth =
    {
        // testdata/probe/coop-Player-host.sav RecordData.FastTravelPointUnlockFlag keys (9)
        "6E03F8464BAD9E458B843AA30BE1CC8F", "DDBBFFAF43D9219AE68DF98744DF0831", "603ED0CD4CFB9AFDC9E11F805594CCE5",
        "6282FE1E4029EDCDB14135AA4C171E4C", "9FBB93D84811BE424A37C391DBFBB476", "979BF2044C8E8FE559B598A95A83EDE3",
        "41727100495D21DC905D309C53989914", "11E3E3C44F040B34E3809CB69CD87435", "74270C2F45B8DCA66B6A1FAAA911D024",
        // RelicObtainForInstanceFlag keys (5)
        "A360858E448AF927AF914D8E9D74E416", "8BCDE3654504C5823162BE83EB674216", "6CA64B00492057D6B5D82D96C534472F",
        "0D0BF38A4E8EF27A57F81CB5154C4633", "E4286D164A8925DFC09D0FBFDA2B3698",
    };

    // FGuid -> UE `Digits` format: A,B,C,D each printed as 8 upper-hex chars (this is the exact
    // string form of the save's FastTravelPointUnlockFlag / RelicObtainForInstanceFlag map keys).
    static string UeDigits(FGuid g) => $"{g.A:X8}{g.B:X8}{g.C:X8}{g.D:X8}";

    static void DiscoverMapGuids(IFileProvider provider)
    {
        var truthFt = new HashSet<string>(GuidGroundTruth.Take(9), StringComparer.OrdinalIgnoreCase);
        var truthEffigy = new HashSet<string>(GuidGroundTruth.Skip(9), StringComparer.OrdinalIgnoreCase);
        var mapCells = provider.Files.Values
            .Where(f => f.Path.EndsWith(".umap", StringComparison.OrdinalIgnoreCase)
                && f.Path.Contains("Pal/Content/Pal/Maps/MainWorld_5/", StringComparison.OrdinalIgnoreCase))
            .ToList();
        var ftGuids = new List<FGuid>();
        var relicGuids = new List<FGuid>();
        foreach (var gf in mapCells)
        {
            if (!provider.TryLoadPackage(gf, out var pkg)) continue;
            for (int i = 0; i < pkg.ExportMapLength; i++)
            {
                var ptr = new FPackageIndex(pkg, i + 1).ResolvedObject;
                var cls = ptr?.Class?.Name.Text;
                bool isRelic = cls == "BP_LevelObject_Relic_C";
                bool isFt = cls == "BP_LevelObject_TowerFastTravelPoint_C";
                if (!isRelic && !isFt) continue;
                var actor = ptr.Object?.Value;
                if (actor == null) continue;
                var g = actor.GetOrDefault<FGuid>("LevelObjectInstanceId");
                (isRelic ? relicGuids : ftGuids).Add(g);
            }
        }
        Console.WriteLine($"[guids] swept ft={ftGuids.Count} relic={relicGuids.Count}; testing encodings vs ground truth (9 FT + 5 effigy)");
        // Candidate string encodings of the actor's LevelObjectInstanceId, tested against the save
        // flag keys. `digits` = UE Digits (four LE uint32 groups, upper-hex). `rawLE` = raw 16 bytes
        // in memory order. `bytesBE` = raw bytes reversed. Whichever encoding matches wins.
        var encoders = new (string name, Func<FGuid, string> f)[]
        {
            ("digits", UeDigits),
            ("rawLE", g => BytesHex(GuidBytes(g), false)),
            ("bytesBE", g => BytesHex(GuidBytes(g), true)),
        };
        foreach (var (name, f) in encoders)
        {
            var ftSet = new HashSet<string>(ftGuids.Select(f), StringComparer.OrdinalIgnoreCase);
            var relicSet = new HashSet<string>(relicGuids.Select(f), StringComparer.OrdinalIgnoreCase);
            int ftHit = truthFt.Count(ftSet.Contains);
            int effHit = truthEffigy.Count(relicSet.Contains);
            Console.WriteLine($"    encoding={name,-8} FT match={ftHit}/9  effigy match={effHit}/5");
        }
    }

    // Raw 16 bytes of an FGuid in memory order: LE(A) ++ LE(B) ++ LE(C) ++ LE(D).
    static byte[] GuidBytes(FGuid g)
    {
        var b = new byte[16];
        BitConverter.GetBytes(g.A).CopyTo(b, 0);
        BitConverter.GetBytes(g.B).CopyTo(b, 4);
        BitConverter.GetBytes(g.C).CopyTo(b, 8);
        BitConverter.GetBytes(g.D).CopyTo(b, 12);
        return b;
    }
    static string BytesHex(byte[] b, bool reversed)
    {
        var sb = new System.Text.StringBuilder(32);
        for (int i = 0; i < b.Length; i++) sb.Append(b[reversed ? b.Length - 1 - i : i].ToString("X2"));
        return sb.ToString();
    }

    // ---- MAP ICON EXTRACTION (--export-map-icons) -----------------------------------------------
    // Emits app/public/map/icons/<key>.png (native res, transparent) + icons.json manifest per
    // Wave-2 contract C1: Record<string,{file,px:[w,h],source}>. The key->asset mapping below is
    // curated by VISUAL INSPECTION of the probe thumbnails dumped by --discover-map-icons (never
    // guessed): each entry was confirmed to depict its key's in-game glyph. Missing keys are simply
    // absent -> the consumer (MapOverlays) degrades to vector fallbacks.
    //
    // marker_<int> keys map the placeable custom-marker palette by EPal...IconType enum ordinal;
    // only emitted when an ordinal<->texture mapping is established from data.
    static readonly (string key, string asset)[] IconAssets =
    {
        // POI glyphs — the in-game map/compass icon set (UI/InGame/T_icon_compass_*).
        ("fast_travel", "Pal/Content/Pal/Texture/UI/InGame/T_icon_compass_FTtower"),   // eagle statue (diamond-framed)
        ("tower",       "Pal/Content/Pal/Texture/UI/InGame/T_icon_compass_tower"),     // tower spire (diamond-framed)
        ("dungeon",     "Pal/Content/Pal/Texture/UI/InGame/T_icon_compass_dungeon"),   // cave archway
        ("bounty",      "Pal/Content/Pal/Texture/UI/InGame/T_icon_compass_Bounty"),    // purple hooded figure
        ("base",        "Pal/Content/Pal/Texture/UI/InGame/T_icon_compass_camp"),      // fortress/castle (player base)
        ("alpha_badge", "Pal/Content/Pal/Texture/UI/Map/T_prt_map_BossIconFrame"),     // white ring/frame drawn around boss pins (tint in UI)
        ("unknown",     "Pal/Content/Pal/Texture/UI/Map/T_icon_compass_Boss_Unknown"), // '?' glyph for undiscovered pins
        ("effigy",      "Pal/Content/Others/InventoryItemIcon/Texture/T_itemicon_Relic"), // green Lifmunk Effigy statuette (item id "Relic")
    };
    // Custom-marker palette: no usmap enum backs the marker IconType (a raw i32 IntProperty in the
    // save); it indexes the contiguous ordinal-named T_icon_compass_00..16 textures 1:1 (17 slots,
    // confirmed via the WBP_IngameCompass_CustomMarker widget + EPalLocationType.CustomMarker). So
    // marker_<N> <- T_icon_compass_<NN> is the data-grounded ordinal mapping, not a guess.
    static readonly (int ord, string enumName, string asset)[] MarkerAssets =
        Enumerable.Range(0, 17)
            .Select(i => (i, "IconType(i32 index; no usmap enum)", $"Pal/Content/Pal/Texture/UI/InGame/T_icon_compass_{i:00}"))
            .ToArray();

    static int ExportMapIcons(IFileProvider provider)
    {
        var mapDir = Path.GetFullPath(Path.Combine(OutDir, "..", "..", "..", "app", "public", "map"));
        var iconDir = Path.Combine(mapDir, "icons");
        Directory.CreateDirectory(iconDir);
        var manifest = new SortedDictionary<string, object>(StringComparer.Ordinal);
        var missing = new List<string>();

        void Emit(string key, string asset)
        {
            try
            {
                if (!provider.TryLoadPackageObject(asset, out var o) || o is not UTexture2D tex)
                { missing.Add($"{key} <- {asset} (not a texture)"); return; }
                using var bmp = tex.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                if (bmp == null) { missing.Add($"{key} <- {asset} (decode null)"); return; }
                using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
                var file = $"{key}.png";
                using (var fs = File.Create(Path.Combine(iconDir, file))) data.SaveTo(fs);
                manifest[key] = new { file, px = new[] { bmp.Width, bmp.Height }, source = asset };
                Console.WriteLine($"[map-icon] {key} {bmp.Width}x{bmp.Height} <- {asset}");
            }
            catch (Exception e) { missing.Add($"{key} <- {asset} ({e.Message})"); }
        }

        foreach (var (key, asset) in IconAssets) Emit(key, asset);
        foreach (var (ord, enumName, asset) in MarkerAssets) Emit($"marker_{ord}", asset);

        File.WriteAllText(Path.Combine(mapDir, "icons.json"), JsonConvert.SerializeObject(manifest, Formatting.Indented));
        Console.WriteLine($"[map-icons] wrote icons.json with {manifest.Count} keys -> {iconDir}");
        if (missing.Count > 0) { Console.WriteLine("[map-icons] MISSING/failed keys:"); foreach (var m in missing) Console.WriteLine("  " + m); }
        Gate_Icons(manifest, iconDir);
        return 0;
    }

    static void Gate_Icons(SortedDictionary<string, object> manifest, string iconDir)
    {
        // every referenced file must exist on disk
        var errs = new List<string>();
        foreach (var kv in manifest)
        {
            var file = (string)GetProp(kv.Value, "file");
            if (!File.Exists(Path.Combine(iconDir, file))) errs.Add($"{kv.Key}: {file} missing on disk");
        }
        if (errs.Count > 0) { Console.WriteLine("==== ICON VALIDATION FAILED ===="); foreach (var e in errs) Console.WriteLine("  FAIL: " + e); }
        else Console.WriteLine("==== ICON GATES PASSED ====");
    }

    static SKBitmap DecodeMapTexture(IFileProvider provider, string path)
    {
        if (!provider.TryLoadPackageObject(path, out var o) || o is not UTexture2D tex) { Console.WriteLine($"[map-tex] MISS {path}"); return null; }
        return tex.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
    }

    static long EncodeWebp(SKBitmap bmp, string outPath, int quality)
    {
        using var data = bmp.Encode(SKEncodedImageFormat.Webp, quality);
        using var fs = File.Create(outPath);
        data.SaveTo(fs);
        return data.Size;
    }

    static string NormTime(string raw)
    {
        var t = StripEnum(raw);
        if (string.Equals(t, "Day", StringComparison.OrdinalIgnoreCase)) return "day";
        if (string.Equals(t, "Night", StringComparison.OrdinalIgnoreCase)) return "night";
        return null;
    }
    static string NormWeather(string raw)
    {
        var w = StripEnum(raw);
        if (string.IsNullOrEmpty(w) || w.Equals("Undefined", StringComparison.OrdinalIgnoreCase) || w.Equals("None", StringComparison.OrdinalIgnoreCase)) return null;
        return w;
    }

    // world->pixel projection for a candidate orientation. u = pixel x (horizontal), v = pixel y (vertical, top-left origin).
    static (double, double) Project(bool uIsY, bool uFlip, bool vFlip, MapLayer L, double wx, double wy)
    {
        double uW = uIsY ? wy : wx, uMin = uIsY ? L.Ymin : L.Xmin, uMax = uIsY ? L.Ymax : L.Xmax;
        double vW = uIsY ? wx : wy, vMin = uIsY ? L.Xmin : L.Ymin, vMax = uIsY ? L.Xmax : L.Ymax;
        double un = (uW - uMin) / (uMax - uMin); if (uFlip) un = 1 - un;
        double vn = (vW - vMin) / (vMax - vMin); if (vFlip) vn = 1 - vn;
        return (un * L.ImgW, vn * L.ImgH);
    }

    static string BuildFormula(bool uIsY, bool uFlip, bool vFlip)
    {
        string Ax(bool isY, bool flip) => isY
            ? (flip ? "(world_max[1]-worldY)/(world_max[1]-world_min[1])" : "(worldY-world_min[1])/(world_max[1]-world_min[1])")
            : (flip ? "(world_max[0]-worldX)/(world_max[0]-world_min[0])" : "(worldX-world_min[0])/(world_max[0]-world_min[0])");
        return $"u_px = {Ax(uIsY, uFlip)} * px[0]; v_px = {Ax(!uIsY, vFlip)} * px[1]  (u=pixel x horizontal, v=pixel y vertical, top-left origin; worldX=world_min[0]..world_max[0], worldY=world_min[1]..world_max[1])";
    }

    // ocean/background is dark blue-green dominant; land is brighter or red-leaning.
    static bool IsLand(SKColor c)
    {
        int lum = (c.Red * 299 + c.Green * 587 + c.Blue * 114) / 1000;
        bool ocean = c.Red < 90 && c.Blue >= c.Red && c.Green >= c.Red && c.Blue > 40;
        return !ocean && lum > 35;
    }

    static void RenderCalibration(SKBitmap worldBmp, MapLayer L, (bool uIsY, bool uFlip, bool vFlip) o,
        List<(string species, double x, double y, int level)> bosses,
        List<(double x, double y, string name, string guid)> ft, List<(double x, double y, double z, string guid)> effigies, string outPath)
    {
        const int S = 1536;
        using var canvas = new SKBitmap(S, S);
        using (var g = new SKCanvas(canvas))
        {
            g.Clear(SKColors.Black);
            g.DrawBitmap(worldBmp, new SKRect(0, 0, worldBmp.Width, worldBmp.Height), new SKRect(0, 0, S, S));
            void Plot(double wx, double wy, SKColor col, float rad)
            {
                if (!L.Contains(wx, wy)) return;
                var (fx, fy) = Project(o.uIsY, o.uFlip, o.vFlip, L, wx, wy);
                using var p = new SKPaint { Color = col, IsAntialias = true, Style = SKPaintStyle.Fill };
                g.DrawCircle((float)(fx * S / L.ImgW), (float)(fy * S / L.ImgH), rad, p);
            }
            foreach (var e in effigies) Plot(e.x, e.y, new SKColor(255, 220, 40, 210), 2.5f);
            foreach (var f in ft) Plot(f.x, f.y, new SKColor(40, 220, 255, 255), 4f);
            foreach (var b in bosses) Plot(b.x, b.y, new SKColor(255, 40, 40, 255), 4f);
        }
        using var data = canvas.Encode(SKEncodedImageFormat.Png, 90);
        using var fs = File.Create(outPath);
        data.SaveTo(fs);
        Console.WriteLine($"[calibrate] wrote {outPath}");
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

    // Reusable discovery pass (`--discover-research`): locate the Lab Research (Pal
    // Labor Research / technology tree) DataTable(s) and dump their shape. Prints every
    // .uasset whose file name mentions Research/LabResearch/Technology/Skillfruit-adjacent
    // labor tokens, loads each as a UDataTable, and dumps row count, first keys, and every
    // row's property schema + a shallow value preview so the emit path can be written against
    // real shape. Also aggregates every distinct enum-looking effect/type field value across
    // rows (flagging breeding-relevant ones by keyword), reports rank/level fields, and finds
    // the matching L10N/en text tables (Research name/desc) so the localized-name join is known.
    static void DiscoverResearch(IFileProvider provider)
    {
        var needles = new[] { "labresearch", "research", "technology", "techtree", "laboratory" };
        bool IsBreedish(string s) => s != null && (
            s.Contains("Breed", StringComparison.OrdinalIgnoreCase)
            || s.Contains("Egg", StringComparison.OrdinalIgnoreCase)
            || s.Contains("Incubat", StringComparison.OrdinalIgnoreCase)
            || s.Contains("Hatch", StringComparison.OrdinalIgnoreCase));

        // (1) candidate DATA tables (exclude L10N text tables here; those are reported in step 3).
        var cands = provider.Files.Keys
            .Where(f => f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Where(f => !f.Contains("/L10N/", StringComparison.OrdinalIgnoreCase))
            .Where(f => needles.Any(n => Path.GetFileNameWithoutExtension(f).Contains(n, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        Console.WriteLine($"[discover-research] candidate data files ({cands.Count}):");
        foreach (var f in cands) Console.WriteLine($"  {f}");

        foreach (var f in cands)
        {
            var pkgPath = f.Substring(0, f.Length - ".uasset".Length);
            UDataTable dt;
            try { if (!provider.TryLoadPackageObject(pkgPath, out var o) || o is not UDataTable d) { Console.WriteLine($"[skip non-datatable] {pkgPath}"); continue; } dt = d; }
            catch (Exception e) { Console.WriteLine($"[load fail] {pkgPath}: {e.Message}"); continue; }
            Console.WriteLine($"==== {pkgPath} rows={dt.RowMap.Count} ====");
            Console.WriteLine($"  keys(first 12)=[{string.Join(", ", dt.RowMap.Keys.Take(12).Select(k => k.Text))}]");

            // Aggregate every distinct value of any enum-looking string field across ALL rows,
            // grouped by field name, flagging breeding-relevant values.
            var fieldEnumVals = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
            foreach (var r in dt.RowMap)
            {
                foreach (var p in r.Value.Properties)
                {
                    var gv = p.Tag?.GenericValue;
                    string sv = gv switch { FName fn => fn.Text, string s => s, _ => gv?.ToString() };
                    if (sv == null) continue;
                    if (!sv.Contains("::") && !sv.StartsWith("EPal", StringComparison.Ordinal)) continue; // enum-ish only
                    if (!fieldEnumVals.TryGetValue(p.Name.Text, out var set)) { set = new SortedSet<string>(StringComparer.Ordinal); fieldEnumVals[p.Name.Text] = set; }
                    set.Add(StripEnum(sv));
                }
            }
            foreach (var kv in fieldEnumVals)
                Console.WriteLine($"  enum field '{kv.Key}' distinct({kv.Value.Count}): {string.Join(", ", kv.Value.Select(v => IsBreedish(v) ? "**" + v + "**" : v))}");

            // Full schema + shallow value preview for the first rows AND any breeding-relevant row.
            int shown = 0;
            foreach (var r in dt.RowMap)
            {
                bool breedRow = r.Value.Properties.Any(p =>
                {
                    var gv = p.Tag?.GenericValue;
                    string sv = gv switch { FName fn => fn.Text, string s => s, _ => gv?.ToString() };
                    return IsBreedish(sv) || IsBreedish(r.Key.Text);
                });
                if (shown >= 4 && !breedRow) continue;
                shown++;
                Console.WriteLine($"  {(breedRow ? "**BREED** " : "")}row '{r.Key.Text}': props=[{string.Join(", ", r.Value.Properties.Select(p => p.Name.Text))}]");
                foreach (var p in r.Value.Properties)
                {
                    var gv = p.Tag?.GenericValue;
                    string preview;
                    if (gv is UScriptArray arr)
                        preview = $"array[{arr.Properties.Count}]" + (arr.Properties.Count > 0 ? " first=" + DumpStruct(arr.Properties[0].GenericValue) : "");
                    else preview = DumpStruct(gv);
                    if (preview.Length > 400) preview = preview.Substring(0, 400) + "...";
                    Console.WriteLine($"      {p.Name.Text} = {preview}");
                }
            }
        }

        // (2) L10N/en text tables mentioning Research/Technology (research names/descriptions).
        Console.WriteLine("[discover-research] L10N/en text tables mentioning research/technology:");
        foreach (var f in provider.Files.Keys.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;
            if (!f.Contains("/L10N/en/", StringComparison.OrdinalIgnoreCase)) continue;
            var stem = Path.GetFileNameWithoutExtension(f);
            if (!(stem.Contains("Research", StringComparison.OrdinalIgnoreCase) || stem.Contains("Technolog", StringComparison.OrdinalIgnoreCase) || stem.Contains("Lab", StringComparison.OrdinalIgnoreCase))) continue;
            var pkgPath = f.Substring(0, f.Length - ".uasset".Length);
            try
            {
                if (!provider.TryLoadPackageObject(pkgPath, out var o) || o is not UDataTable dt) continue;
                Console.WriteLine($"  TEXT {pkgPath} rows={dt.RowMap.Count} keys(first 8)=[{string.Join(", ", dt.RowMap.Keys.Take(8).Select(k => k.Text))}]");
                foreach (var r in dt.RowMap.Take(6))
                {
                    string txt = null;
                    try { txt = r.Value.Get<FText>("TextData")?.Text; } catch { }
                    Console.WriteLine($"      '{r.Key.Text}' = {(txt == null ? "(no TextData)" : txt.Replace("\n", " ").Trim())}");
                }
            }
            catch { }
        }
    }

    // Reusable discovery pass (`--discover-drops`): locate the per-species item-drop source.
    // (1) Dump DT_PalMonsterParameter row schema for a few known species, flagging any field
    //     whose name hints at drops/loot/item. (2) Find every non-L10N .uasset whose file name
    //     mentions Drop/ItemLottery/PalDropItem/Loot and dump its schema + shallow value preview
    //     of the first rows and a known-species row (e.g. a starter) so the emit path is written
    //     against real shape. (3) Report which candidate table is keyed by species internal name.
    static void DiscoverDrops(IFileProvider provider)
    {
        bool IsDropish(string s) => s != null && (
            s.Contains("Drop", StringComparison.OrdinalIgnoreCase)
            || s.Contains("Loot", StringComparison.OrdinalIgnoreCase)
            || s.Contains("Lottery", StringComparison.OrdinalIgnoreCase)
            || s.Contains("Item", StringComparison.OrdinalIgnoreCase));

        // (1) DT_PalMonsterParameter row schema — flag any drop/item-ish field.
        var monsters = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalMonsterParameter");
        Console.WriteLine($"[discover-drops] DT_PalMonsterParameter rows={monsters.RowMap.Count}");
        var monFields = monsters.RowMap.First().Value.Properties.Select(p => p.Name.Text).ToList();
        Console.WriteLine($"[discover-drops] DT_PalMonsterParameter fields ({monFields.Count}): {string.Join(", ", monFields)}");
        var dropFields = monFields.Where(IsDropish).ToList();
        Console.WriteLine($"[discover-drops] drop/item-ish fields on monster rows: [{string.Join(", ", dropFields)}]");
        foreach (var probe in new[] { "SheepBall", "PinkCat", "ElecPanda", "Anubis" })
        {
            if (!monsters.RowMap.TryGetValue(new FName(probe), out var row)) continue;
            var stat = row.Properties.Where(p => new[] { "Support", "CaptureRateCorrect", "ExpRatio" }.Contains(p.Name.Text))
                .Select(p => $"{p.Name.Text}={p.Tag?.GenericValue}");
            Console.WriteLine($"  '{probe}' stat-probe: {string.Join(", ", stat)}");
            foreach (var df in dropFields)
                Console.WriteLine($"  '{probe}' {df} = {DumpStruct(row.Properties.First(p => p.Name.Text == df).Tag?.GenericValue)}");
        }

        // (2) dedicated drop tables by file name.
        var needles = new[] { "drop", "itemlottery", "paldropitem", "loot", "dropitem" };
        var cands = provider.Files.Keys
            .Where(f => f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Where(f => !f.Contains("/L10N/", StringComparison.OrdinalIgnoreCase))
            .Where(f => needles.Any(n => Path.GetFileNameWithoutExtension(f).Contains(n, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        Console.WriteLine($"[discover-drops] candidate drop tables ({cands.Count}):");
        foreach (var f in cands) Console.WriteLine($"  {f}");
        foreach (var f in cands)
        {
            var pkgPath = f.Substring(0, f.Length - ".uasset".Length);
            UDataTable dt;
            try { if (!provider.TryLoadPackageObject(pkgPath, out var o) || o is not UDataTable d) { Console.WriteLine($"[skip non-datatable] {pkgPath}"); continue; } dt = d; }
            catch (Exception e) { Console.WriteLine($"[load fail] {pkgPath}: {e.Message}"); continue; }
            Console.WriteLine($"==== {pkgPath} rows={dt.RowMap.Count} ====");
            Console.WriteLine($"  keys(first 16)=[{string.Join(", ", dt.RowMap.Keys.Take(16).Select(k => k.Text))}]");
            int shown = 0;
            foreach (var r in dt.RowMap)
            {
                bool speciesRow = new[] { "SheepBall", "PinkCat", "ElecPanda", "Anubis", "Boar", "Deer" }
                    .Any(sp => r.Key.Text.Contains(sp, StringComparison.OrdinalIgnoreCase));
                if (shown >= 4 && !speciesRow) continue;
                shown++;
                Console.WriteLine($"  {(speciesRow ? "**SP** " : "")}row '{r.Key.Text}': props=[{string.Join(", ", r.Value.Properties.Select(p => p.Name.Text))}]");
                foreach (var p in r.Value.Properties)
                {
                    var gv = p.Tag?.GenericValue;
                    string preview;
                    if (gv is UScriptArray arr)
                        preview = $"array[{arr.Properties.Count}]" + (arr.Properties.Count > 0 ? " first=" + DumpStruct(arr.Properties[0].GenericValue) : "")
                            + (arr.Properties.Count > 1 ? " second=" + DumpStruct(arr.Properties[1].GenericValue) : "");
                    else preview = DumpStruct(gv);
                    if (preview.Length > 500) preview = preview.Substring(0, 500) + "...";
                    Console.WriteLine($"      {p.Name.Text} = {preview}");
                }
            }
        }
        // (3) grouping analysis: rows-per-CharacterID, table diff, CharacterID<->monster-key join.
        var monKeys = new HashSet<string>(monsters.RowMap.Keys.Select(k => k.Text), StringComparer.Ordinal);
        var primary = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalDropItem");
        var common = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalDropItem_Common");
        string CharId(FStructFallback r) => S(Vals(r), "CharacterID");
        var byChar = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var r in primary.RowMap)
            (byChar.TryGetValue(CharId(r.Value) ?? "?", out var l) ? l : (byChar[CharId(r.Value) ?? "?"] = new List<string>())).Add(r.Key.Text);
        var multi = byChar.Where(kv => kv.Value.Count > 1).ToList();
        Console.WriteLine($"[discover-drops] DT_PalDropItem distinctCharacterID={byChar.Count} multiRowChars={multi.Count}");
        foreach (var kv in multi.Take(12)) Console.WriteLine($"    MULTI {kv.Key}: [{string.Join(", ", kv.Value)}]");
        int charInMon = byChar.Keys.Count(c => monKeys.Contains(c));
        var charNotInMon = byChar.Keys.Where(c => !monKeys.Contains(c)).ToList();
        Console.WriteLine($"[discover-drops] CharacterID in DT_PalMonsterParameter: {charInMon}/{byChar.Count}; NOT matched ({charNotInMon.Count}): {string.Join(", ", charNotInMon.Take(30))}");
        // diff DT_PalDropItem vs _Common per row key
        int diffRows = 0; var diffSample = new List<string>();
        foreach (var r in primary.RowMap)
        {
            if (!common.RowMap.TryGetValue(r.Key, out var cr)) { diffRows++; if (diffSample.Count < 8) diffSample.Add($"{r.Key.Text}(no-common)"); continue; }
            var pv = Vals(r.Value); var cv = Vals(cr);
            bool same = true;
            for (int n = 1; n <= 10; n++)
                if (S(pv, "ItemId" + n) != S(cv, "ItemId" + n) || F(pv, "Rate" + n) != F(cv, "Rate" + n)
                    || I(pv, "min" + n) != I(cv, "min" + n) || I(pv, "Max" + n) != I(cv, "Max" + n)) { same = false; break; }
            if (!same) { diffRows++; if (diffSample.Count < 8) diffSample.Add(r.Key.Text); }
        }
        Console.WriteLine($"[discover-drops] DT_PalDropItem vs _Common differing rows={diffRows} sample=[{string.Join(", ", diffSample)}]");
        // stat probe on real monster keys (starter + Orserk task example)
        foreach (var probe in new[] { "SheepBall", "PinkCat", "ElecPanda", "Anubis", "Boar" })
        {
            var mrow = monsters.RowMap.FirstOrDefault(x => x.Key.Text == probe).Value;
            if (mrow == null) { Console.WriteLine($"  '{probe}' NOT in monster table"); continue; }
            var mv = Vals(mrow);
            Console.WriteLine($"  '{probe}' Support={F(mv, "Support")} CaptureRateCorrect={F(mv, "CaptureRateCorrect")} ExpRatio={F(mv, "ExpRatio")}");
            var drow = byChar.TryGetValue(probe, out var keys) ? primary.RowMap.First(x => x.Key.Text == keys[0]).Value : null;
            if (drow != null)
            {
                var dv = Vals(drow);
                var slots = new List<string>();
                for (int n = 1; n <= 10; n++) { var it = S(dv, "ItemId" + n); if (!string.IsNullOrEmpty(it) && it != "None") slots.Add($"{it} {I(dv, "min" + n)}-{I(dv, "Max" + n)}@{FmtNum(F(dv, "Rate" + n))}%"); }
                Console.WriteLine($"      drops: {string.Join(", ", slots)}");
            }
        }
    }

    // Reusable discovery pass (`--discover-element`): locate the elemental damage-rate
    // (attacker-element vs defender-element multiplier) table. Search non-L10N .uasset file
    // names for Element/DamageRate/AttributeRate/Compatibility tokens, load each as a UDataTable
    // OR a UObject CDO, and dump schema + values so a typed matchup chart can be emitted (or the
    // absence honestly reported when the data is code-side only).
    static void DiscoverElement(IFileProvider provider)
    {
        // Definitive sweep: EVERY DataTable-dir .uasset whose name hints at element/attribute
        // effectiveness, loaded and checked for an element-keyed multiplier matrix.
        var dtHints = new[] { "element", "attribute", "typechart", "damagerate", "weak", "resist", "effective", "compat" };
        var dtCands = provider.Files.Keys
            .Where(f => f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Where(f => f.Contains("/DataTable/", StringComparison.OrdinalIgnoreCase))
            .Where(f => dtHints.Any(h => Path.GetFileNameWithoutExtension(f).Contains(h, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(x => x, StringComparer.Ordinal).ToList();
        Console.WriteLine($"[discover-element] DataTable-dir files hinting element/attribute effectiveness ({dtCands.Count}):");
        foreach (var f in dtCands)
        {
            var pkg = f.Substring(0, f.Length - ".uasset".Length);
            try
            {
                if (provider.TryLoadPackageObject(pkg, out var o) && o is UDataTable dt)
                    Console.WriteLine($"  TABLE {pkg} rows={dt.RowMap.Count} keys=[{string.Join(", ", dt.RowMap.Keys.Take(12).Select(k => k.Text))}]");
                else Console.WriteLine($"  (non-table) {pkg}");
            }
            catch (Exception e) { Console.WriteLine($"  [fail] {pkg}: {e.Message}"); }
        }
        var needles = new[] { "elementdamage", "elementaldamage", "damagerate", "attributerate", "elementcompat", "compatibility", "elementrate", "typechart", "attackrate" };
        var cands = provider.Files.Keys
            .Where(f => f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Where(f => !f.Contains("/L10N/", StringComparison.OrdinalIgnoreCase))
            .Where(f => needles.Any(n => Path.GetFileNameWithoutExtension(f).Contains(n, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        Console.WriteLine($"[discover-element] candidate files by name ({cands.Count}):");
        foreach (var f in cands) Console.WriteLine($"  {f}");
        // Broaden: any .uasset whose name contains "Element" (report only, no load) so we see the space.
        var elemNamed = provider.Files.Keys
            .Where(f => f.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Where(f => !f.Contains("/L10N/", StringComparison.OrdinalIgnoreCase))
            .Where(f => Path.GetFileNameWithoutExtension(f).Contains("Element", StringComparison.OrdinalIgnoreCase))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        Console.WriteLine($"[discover-element] all non-L10N files mentioning 'Element' ({elemNamed.Count}):");
        foreach (var f in elemNamed) Console.WriteLine($"  {f}");
        foreach (var f in cands.Concat(elemNamed).Distinct())
        {
            var pkgPath = f.Substring(0, f.Length - ".uasset".Length);
            try
            {
                if (!provider.TryLoadPackageObject(pkgPath, out var o)) { Console.WriteLine($"[no-object] {pkgPath}"); continue; }
                if (o is UDataTable dt)
                {
                    Console.WriteLine($"==== TABLE {pkgPath} rows={dt.RowMap.Count} ====");
                    Console.WriteLine($"  keys=[{string.Join(", ", dt.RowMap.Keys.Take(20).Select(k => k.Text))}]");
                    foreach (var r in dt.RowMap.Take(12))
                        Console.WriteLine($"  row '{r.Key.Text}': [{string.Join(", ", r.Value.Properties.Select(p => $"{p.Name.Text}={p.Tag?.GenericValue}"))}]");
                }
                else
                {
                    Console.WriteLine($"==== CDO {pkgPath} type={o.GetType().Name} class={o.Class?.Name} ====");
                    foreach (var p in o.Properties.Take(40))
                    {
                        var gv = p.Tag?.GenericValue;
                        string preview = gv is UScriptArray arr
                            ? $"array[{arr.Properties.Count}]" + (arr.Properties.Count > 0 ? " first=" + DumpStruct(arr.Properties[0].GenericValue) : "")
                            : DumpStruct(gv);
                        if (preview.Length > 500) preview = preview.Substring(0, 500) + "...";
                        Console.WriteLine($"      {p.Name.Text} = {preview}");
                    }
                }
            }
            catch (Exception e) { Console.WriteLine($"[load fail] {pkgPath}: {e.Message}"); }
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
    // chance), EggAlphaConversion (alpha-egg chance: raises the odds the hatched Pal is an
    // Alpha (+20% HP, larger size), no breeding-effort impact). Partner skills grant these
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

    // ---- lab research extraction (Pal Labor Research tree) ----
    // The research lab's tech tree lives in DT_LabResearchDataTable: one row per research
    // NODE, keyed generically (e.g. `EmitFlame2`, `Cool2_3`), grouped by the work suitability
    // required to research it (`LabCategoryWorkSuitability`) and a `LabCategorySubType`. Each
    // node grants a global buff via the SAME `EPalPassiveSkillEffectType` enum as passives
    // (`EffectType` + `EffectValue` percent), and chains to its predecessor via
    // `RequiredResearchId`. We keep ONLY nodes whose EffectType is breeding-relevant (the
    // shared `BreedEffect` map — build 24181527 has exactly PalEggHatchingSpeed ->
    // incubation_speed), group them per work-suitability category, order each group by the
    // prerequisite chain, and emit one LINE per group with the cumulative per-rank fraction
    // (node EffectValues are INCREMENTAL, so rank N's fraction = sum of the first N nodes).
    // Localized node names come from the L10N/en DT_LabResearchText (keyed by the row's TextId);
    // the line name is the first node's name with a trailing " LvN" stripped. Returns the lines
    // plus (table row count, emitted node count) for coverage auditing.
    static readonly Regex LabLvSuffix = new(@"\s*Lv\.?\s*\d+\s*$", RegexOptions.IgnoreCase);
    static (List<object> lines, int tableRows, int emitted) ExtractLabResearch(
        IFileProvider provider, Dictionary<string, string> researchNames)
    {
        var tab = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Lab/DT_LabResearchDataTable");
        // One record per breeding-relevant research node.
        var nodes = new List<(string id, string cat, string subType, string effect, double frac, string reqId, long work, string name)>();
        foreach (var r in tab.RowMap)
        {
            var v = Vals(r.Value);
            var effect = BreedEffect(StripEnum(S(v, "EffectType")));
            if (effect == null) continue;
            var textId = S(v, "TextId");
            var name = textId != null && researchNames.TryGetValue(textId, out var nm) ? Clean(nm) : null;
            nodes.Add((
                r.Key.Text,
                StripEnum(S(v, "LabCategoryWorkSuitability")) ?? "Unknown",
                StripEnum(S(v, "LabCategorySubType")),
                effect,
                F(v, "EffectValue") / 100.0,
                NonNone(StripEnum(S(v, "RequiredResearchId"))),
                (long)Math.Round(F(v, "RequiredWorkAmount")),
                name));
        }

        var lines = new List<object>();
        foreach (var g in nodes.GroupBy(n => n.cat).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var group = g.ToList();
            var groupIds = new HashSet<string>(group.Select(n => n.id));
            // Chain root = the node whose prerequisite is outside this group (or absent).
            // Order forward by following RequiredResearchId (successor.reqId == current.id).
            var ordered = new List<(string id, string cat, string subType, string effect, double frac, string reqId, long work, string name)>();
            var seen = new HashSet<string>();
            var cur = group.FirstOrDefault(n => n.reqId == null || !groupIds.Contains(n.reqId));
            while (cur.id != null && seen.Add(cur.id))
            {
                ordered.Add(cur);
                cur = group.FirstOrDefault(n => n.reqId == ordered[^1].id);
            }
            // Any node not reached by the chain walk (branching/unexpected shape) is appended
            // by ascending effort so nothing is silently dropped.
            foreach (var n in group.Where(n => !seen.Contains(n.id)).OrderBy(n => n.work))
                ordered.Add(n);

            double cum = 0;
            var valuesPerRank = new List<double>();
            var nodeObjs = new List<object>();
            int rank = 0;
            foreach (var n in ordered)
            {
                cum = Math.Round(cum + n.frac, 6);
                rank++;
                valuesPerRank.Add(cum);
                nodeObjs.Add(new
                {
                    id = n.id,
                    name = n.name,
                    rank,
                    effect_value = Math.Round(n.frac, 6),
                    cumulative = cum,
                    required_research_id = n.reqId,
                    required_work_amount = n.work,
                });
            }
            var first = ordered[0];
            var lineName = first.name != null ? LabLvSuffix.Replace(first.name, "").Trim() : null;
            if (string.IsNullOrEmpty(lineName)) lineName = "Egg Hatching Speed";
            lines.Add(new
            {
                id = g.Key,
                name = lineName,
                category = g.Key,
                sub_type = first.subType,
                effect = first.effect,
                values_per_rank = valuesPerRank,
                nodes = nodeObjs,
            });
        }
        return (lines, tab.RowMap.Count, nodes.Count);
    }

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
