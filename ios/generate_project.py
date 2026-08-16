#!/usr/bin/env python3
"""Regenerate GriffinFund.xcodeproj/project.pbxproj from the source directory.

The README used to claim a script like this already existed. It did not, and
the cost was real: adding a source file meant hand-writing 24-hex-digit object
IDs into five separate places in the pbxproj, which is exactly the kind of
edit that half-succeeds and produces a target that compiles without the file
it needs.

Object IDs are derived from an MD5 of a stable key rather than randomly
generated, so regenerating with no source changes produces a byte-identical
file and the diff on a real change shows only the real change. MD5 is doing
nothing security-relevant here; it is a name-to-24-hex-digits function.

Usage:  python3 ios/generate_project.py
"""

import hashlib
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
APP = ROOT / "GriffinFund"
PBXPROJ = ROOT / "GriffinFund.xcodeproj" / "project.pbxproj"

# Read from the project, not hardcoded into Info.plist. Info.plist reads these
# back through $(MARKETING_VERSION) and $(CURRENT_PROJECT_VERSION), so a bump
# here is a bump in the built app. The previous arrangement hardcoded the
# version in Info.plist with GENERATE_INFOPLIST_FILE = NO, which meant the
# commit titled "0.1.1" shipped an app still identifying itself as 0.1.0 (1)
# and App Store Connect would have rejected the next upload as a duplicate.
MARKETING_VERSION = "0.4.0"
BUILD_NUMBER = "6"

BUNDLE_ID = "org.thegriffinfund.ios"
DISPLAY_NAME = "Griffin Fund"
DEVELOPMENT_TEAM = "PW2VT56789"
DEPLOYMENT_TARGET = "17.0"
# Swift 6 strict concurrency is the Mac target's standard and is where this
# should end up. It is deliberately not flipped in the same change as the UI
# rebuild: the two produce overlapping error surfaces and neither would be
# reviewable. Tracked, not forgotten.
SWIFT_VERSION = "5.0"


def oid(key: str) -> str:
    return hashlib.md5(key.encode()).hexdigest()[:24].upper()


def main() -> None:
    sources = sorted(p.name for p in APP.glob("*.swift"))
    if not sources:
        raise SystemExit(f"No Swift sources found in {APP}")

    file_refs, build_files, group_children, source_files = [], [], [], []
    for name in sources:
        fref, bfile = oid(f"fileref:{name}"), oid(f"buildfile:{name}")
        file_refs.append(
            f"\t\t{fref} /* {name} */ = {{isa = PBXFileReference; "
            f"lastKnownFileType = sourcecode.swift; path = {name}; sourceTree = \"<group>\"; }};"
        )
        build_files.append(
            f"\t\t{bfile} /* {name} in Sources */ = {{isa = PBXBuildFile; "
            f"fileRef = {fref} /* {name} */; }};"
        )
        group_children.append(f"\t\t\t\t{fref} /* {name} */,")
        source_files.append(f"\t\t\t\t{bfile} /* {name} in Sources */,")

    ids = {k: oid(k) for k in (
        "assets_ref", "assets_build", "info_ref", "product", "frameworks",
        "main_group", "products_group", "app_group", "target", "project",
        "resources", "sources", "cfg_debug", "cfg_release",
        "tcfg_debug", "tcfg_release", "cfglist_project", "cfglist_target",
    )}

    common_target = (
        f"ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; CODE_SIGN_STYLE = Automatic;\n"
        f"\t\t\tDEVELOPMENT_TEAM = {DEVELOPMENT_TEAM};\n"
        f"\t\t\tCURRENT_PROJECT_VERSION = {BUILD_NUMBER}; GENERATE_INFOPLIST_FILE = NO;\n"
        f"\t\t\tINFOPLIST_FILE = GriffinFund/Info.plist;\n"
        f"\t\t\tINFOPLIST_KEY_CFBundleDisplayName = \"{DISPLAY_NAME}\";\n"
        f"\t\t\tLD_RUNPATH_SEARCH_PATHS = (\"$(inherited)\", \"@executable_path/Frameworks\");\n"
        f"\t\t\tMARKETING_VERSION = {MARKETING_VERSION}; PRODUCT_BUNDLE_IDENTIFIER = {BUNDLE_ID};\n"
        f"\t\t\tPRODUCT_NAME = \"$(TARGET_NAME)\"; SWIFT_EMIT_LOC_STRINGS = YES;\n"
        f"\t\t\tTARGETED_DEVICE_FAMILY = \"1,2\";"
    )

    nl = "\n"
    out = f"""// !$*UTF8*$!
{{
\tarchiveVersion = 1;
\tclasses = {{}};
\tobjectVersion = 56;
\tobjects = {{
\t\t{ids['assets_build']} /* Assets.xcassets in Resources */ = {{isa = PBXBuildFile; fileRef = {ids['assets_ref']} /* Assets.xcassets */; }};
{nl.join(build_files)}
{nl.join(file_refs)}
\t\t{ids['info_ref']} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; }};
\t\t{ids['assets_ref']} /* Assets.xcassets */ = {{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; }};
\t\t{ids['product']} /* GriffinFund.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = GriffinFund.app; sourceTree = BUILT_PRODUCTS_DIR; }};
\t\t{ids['frameworks']} = {{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; }};
\t\t{ids['main_group']} = {{isa = PBXGroup; children = (
\t\t\t\t{ids['app_group']} /* GriffinFund */,
\t\t\t\t{ids['products_group']} /* Products */,
\t\t\t); sourceTree = "<group>"; }};
\t\t{ids['products_group']} /* Products */ = {{isa = PBXGroup; children = (
\t\t\t\t{ids['product']} /* GriffinFund.app */,
\t\t\t); name = Products; sourceTree = "<group>"; }};
\t\t{ids['app_group']} /* GriffinFund */ = {{isa = PBXGroup; children = (
{nl.join(group_children)}
\t\t\t\t{ids['info_ref']} /* Info.plist */,
\t\t\t\t{ids['assets_ref']} /* Assets.xcassets */,
\t\t\t); path = GriffinFund; sourceTree = "<group>"; }};
\t\t{ids['target']} /* GriffinFund */ = {{isa = PBXNativeTarget; buildConfigurationList = {ids['cfglist_target']}; buildPhases = (
\t\t\t\t{ids['sources']},
\t\t\t\t{ids['frameworks']},
\t\t\t\t{ids['resources']},
\t\t\t); buildRules = (); dependencies = (); name = GriffinFund; productName = GriffinFund; productReference = {ids['product']}; productType = "com.apple.product-type.application"; }};
\t\t{ids['project']} /* Project object */ = {{isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 2600; LastUpgradeCheck = 2600; }};
\t\t\tbuildConfigurationList = {ids['cfglist_project']}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0;
\t\t\tknownRegions = (en, Base); mainGroup = {ids['main_group']}; productRefGroup = {ids['products_group']}; projectDirPath = ""; projectRoot = "";
\t\t\ttargets = ({ids['target']} /* GriffinFund */); }};
\t\t{ids['resources']} = {{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (
\t\t\t\t{ids['assets_build']} /* Assets.xcassets in Resources */,
\t\t\t); runOnlyForDeploymentPostprocessing = 0; }};
\t\t{ids['sources']} = {{isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (
{nl.join(source_files)}
\t\t\t); runOnlyForDeploymentPostprocessing = 0; }};
\t\t{ids['cfg_debug']} = {{isa = XCBuildConfiguration; buildSettings = {{
\t\t\tALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; ENABLE_STRICT_OBJC_MSGSEND = YES;
\t\t\tIPHONEOS_DEPLOYMENT_TARGET = {DEPLOYMENT_TARGET}; SDKROOT = iphoneos; SWIFT_VERSION = {SWIFT_VERSION};
\t\t\tONLY_ACTIVE_ARCH = YES; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; DEBUG_INFORMATION_FORMAT = dwarf;
\t\t\tGCC_OPTIMIZATION_LEVEL = 0; }}; name = Debug; }};
\t\t{ids['cfg_release']} = {{isa = XCBuildConfiguration; buildSettings = {{
\t\t\tALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; ENABLE_STRICT_OBJC_MSGSEND = YES;
\t\t\tIPHONEOS_DEPLOYMENT_TARGET = {DEPLOYMENT_TARGET}; SDKROOT = iphoneos; SWIFT_VERSION = {SWIFT_VERSION};
\t\t\tSWIFT_COMPILATION_MODE = wholemodule; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; }}; name = Release; }};
\t\t{ids['tcfg_debug']} = {{isa = XCBuildConfiguration; buildSettings = {{
\t\t\t{common_target} }}; name = Debug; }};
\t\t{ids['tcfg_release']} = {{isa = XCBuildConfiguration; buildSettings = {{
\t\t\t{common_target} }}; name = Release; }};
\t\t{ids['cfglist_project']} = {{isa = XCConfigurationList; buildConfigurations = ({ids['cfg_debug']}, {ids['cfg_release']}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; }};
\t\t{ids['cfglist_target']} = {{isa = XCConfigurationList; buildConfigurations = ({ids['tcfg_debug']}, {ids['tcfg_release']}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; }};
\t}};
\trootObject = {ids['project']} /* Project object */;
}}
"""
    PBXPROJ.parent.mkdir(parents=True, exist_ok=True)
    PBXPROJ.write_text(out)
    print(f"Wrote {PBXPROJ.relative_to(ROOT.parent)} with {len(sources)} sources:")
    for name in sources:
        print(f"  {name}")
    print(f"Version {MARKETING_VERSION} ({BUILD_NUMBER})")


if __name__ == "__main__":
    main()
