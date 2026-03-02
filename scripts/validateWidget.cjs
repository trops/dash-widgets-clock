#!/usr/bin/env node

/**
 * validateWidget.cjs
 *
 * Validates a widget manifest and optionally the referenced ZIP archive.
 *
 * Usage:
 *   node scripts/validateWidget.cjs path/to/manifest.json          # Schema-only
 *   node scripts/validateWidget.cjs path/to/manifest.json --full   # Schema + ZIP
 *   node scripts/validateWidget.cjs path/to/manifest.json --json   # JSON output
 *   node scripts/validateWidget.cjs path/to/manifest.json --full --json
 *
 * Exit codes:
 *   0 = passed (no errors, no warnings)
 *   1 = errors found
 *   2 = warnings only (e.g. ZIP not yet available)
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const GITHUB_USER_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const WIDGET_ID_RE = /^[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.[A-Z][a-zA-Z0-9]*$/;

const VALID_CATEGORIES = [
    "general",
    "utilities",
    "productivity",
    "development",
    "social",
    "media",
    "finance",
    "health",
    "education",
    "entertainment",
];

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate a manifest object against the registry schema.
 * @param {Object} manifest - Parsed manifest object
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateManifestSchema(manifest) {
    const errors = [];
    const warnings = [];

    if (!manifest || typeof manifest !== "object") {
        errors.push("Manifest must be a non-null object");
        return { errors, warnings };
    }

    // --- Required string fields ---
    // Support both "githubUser" (new) and "scope" (legacy) for backward compat
    const hasGithubUser =
        typeof manifest.githubUser === "string" && manifest.githubUser.trim();
    const hasScope =
        typeof manifest.scope === "string" && manifest.scope.trim();

    if (!hasGithubUser && !hasScope) {
        errors.push(
            `"githubUser" is required and must be a non-empty string (GitHub username used for identity)`
        );
    }

    const requiredStrings = [
        "name",
        "displayName",
        "author",
        "description",
        "version",
        "category",
        "downloadUrl",
    ];

    for (const field of requiredStrings) {
        if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
            errors.push(
                `"${field}" is required and must be a non-empty string`
            );
        }
    }

    // --- repository (optional) ---
    // Repository is no longer required — publishing without a separate repo is supported
    if (typeof manifest.repository === "string" && manifest.repository.trim()) {
        if (
            !manifest.repository.startsWith("https://") &&
            !manifest.repository.startsWith("http://")
        ) {
            warnings.push(
                `"repository" should be a full URL (got "${manifest.repository}")`
            );
        }
    }

    // --- githubUser format ---
    if (hasGithubUser && !GITHUB_USER_RE.test(manifest.githubUser)) {
        errors.push(
            `"githubUser" must be a valid GitHub username (got "${manifest.githubUser}"). Pattern: letters, digits, hyphens`
        );
    }

    // --- scope format (legacy backward compat) ---
    if (hasScope && !hasGithubUser && !KEBAB_CASE_RE.test(manifest.scope)) {
        errors.push(
            `"scope" must be kebab-case (got "${manifest.scope}"). Example: "my-username"`
        );
    }

    // --- name format ---
    if (
        typeof manifest.name === "string" &&
        manifest.name.trim() &&
        !KEBAB_CASE_RE.test(manifest.name)
    ) {
        errors.push(
            `"name" must be kebab-case (got "${manifest.name}"). Example: "my-widget-pack"`
        );
    }

    // --- version format ---
    if (
        typeof manifest.version === "string" &&
        manifest.version.trim() &&
        !SEMVER_RE.test(manifest.version)
    ) {
        errors.push(
            `"version" must be valid semver (got "${manifest.version}"). Example: "1.0.0"`
        );
    }

    // --- category ---
    if (
        typeof manifest.category === "string" &&
        manifest.category.trim() &&
        !VALID_CATEGORIES.includes(manifest.category)
    ) {
        warnings.push(
            `"category" "${
                manifest.category
            }" is not in the known list: ${VALID_CATEGORIES.join(", ")}`
        );
    }

    // --- downloadUrl must contain {version} ---
    if (
        typeof manifest.downloadUrl === "string" &&
        manifest.downloadUrl.trim()
    ) {
        if (!manifest.downloadUrl.includes("{version}")) {
            errors.push(
                `"downloadUrl" must contain the "{version}" placeholder so the registry can resolve versioned URLs`
            );
        }
    }

    // --- tags (optional) ---
    if (manifest.tags !== undefined) {
        if (!Array.isArray(manifest.tags)) {
            errors.push(`"tags" must be an array of strings`);
        } else {
            manifest.tags.forEach((tag, i) => {
                if (typeof tag !== "string" || !tag.trim()) {
                    errors.push(`"tags[${i}]" must be a non-empty string`);
                }
            });
        }
    }

    // --- publishedAt (optional) ---
    if (manifest.publishedAt !== undefined) {
        if (
            typeof manifest.publishedAt !== "string" ||
            !ISO_8601_RE.test(manifest.publishedAt)
        ) {
            warnings.push(
                `"publishedAt" should be ISO 8601 (got "${manifest.publishedAt}")`
            );
        }
    }

    // --- widgets array ---
    if (!Array.isArray(manifest.widgets)) {
        errors.push(`"widgets" is required and must be an array`);
    } else if (manifest.widgets.length === 0) {
        errors.push(`"widgets" must contain at least one widget entry`);
    } else {
        const githubUser = manifest.githubUser || manifest.scope;
        const packageName = manifest.name;

        manifest.widgets.forEach((widget, i) => {
            const prefix = `widgets[${i}]`;

            if (typeof widget.name !== "string" || !widget.name.trim()) {
                errors.push(
                    `${prefix}.name is required and must be a non-empty string`
                );
            } else if (!PASCAL_CASE_RE.test(widget.name)) {
                warnings.push(
                    `${prefix}.name should be PascalCase (got "${widget.name}")`
                );
            }

            // --- id validation (optional but validated if present) ---
            if (widget.id !== undefined) {
                if (typeof widget.id !== "string" || !widget.id.trim()) {
                    errors.push(
                        `${prefix}.id must be a non-empty string if provided`
                    );
                } else if (!WIDGET_ID_RE.test(widget.id)) {
                    errors.push(
                        `${prefix}.id must match "{githubUser}.{package}.{widgetName}" format (got "${widget.id}")`
                    );
                } else if (githubUser && packageName && widget.name) {
                    // Verify id components match manifest fields
                    const expectedId = `${githubUser}.${packageName}.${widget.name}`;
                    if (widget.id !== expectedId) {
                        errors.push(
                            `${prefix}.id mismatch: expected "${expectedId}" but got "${widget.id}"`
                        );
                    }
                }
            }

            if (
                typeof widget.displayName !== "string" ||
                !widget.displayName.trim()
            ) {
                errors.push(
                    `${prefix}.displayName is required and must be a non-empty string`
                );
            }

            if (
                typeof widget.description !== "string" ||
                !widget.description.trim()
            ) {
                errors.push(
                    `${prefix}.description is required and must be a non-empty string`
                );
            }

            if (widget.icon === undefined || widget.icon === null) {
                warnings.push(`${prefix}.icon is recommended but missing`);
            }

            // providers (optional array)
            if (widget.providers !== undefined) {
                if (!Array.isArray(widget.providers)) {
                    errors.push(`${prefix}.providers must be an array`);
                } else {
                    widget.providers.forEach((prov, j) => {
                        if (
                            typeof prov.type !== "string" ||
                            !prov.type.trim()
                        ) {
                            errors.push(
                                `${prefix}.providers[${j}].type is required`
                            );
                        }
                        if (
                            prov.required !== undefined &&
                            typeof prov.required !== "boolean"
                        ) {
                            errors.push(
                                `${prefix}.providers[${j}].required must be a boolean`
                            );
                        }
                    });
                }
            }
        });
    }

    return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Config parsing (inlined from DynamicWidgetLoader.loadConfigFile)
// ---------------------------------------------------------------------------

/**
 * Parse a .dash.js config file and return its exported object.
 * Uses regex + vm.runInContext — no Electron dependency.
 *
 * @param {string} configPath - Absolute path to a .dash.js file
 * @returns {{ config: Object|null, error: string|null }}
 */
function parseDashConfig(configPath) {
    try {
        const source = fs.readFileSync(configPath, "utf8");

        // Try direct export: export default { ... }
        let exportMatch = source.match(/export\s+default\s+({[\s\S]*});?\s*$/);

        let exportedObjectStr;

        if (exportMatch) {
            exportedObjectStr = exportMatch[1];
        } else {
            // Try variable export: const/let/var name = { ... }; export default name;
            const varExportMatch = source.match(
                /export\s+default\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*;?\s*$/
            );
            if (varExportMatch) {
                const varName = varExportMatch[1];
                // Find the variable declaration with object literal
                const varDeclMatch = source.match(
                    new RegExp(
                        `(?:const|let|var)\\s+${varName}\\s*=\\s*({[\\s\\S]*?});\\s*(?:export\\s+default)`
                    )
                );
                if (varDeclMatch) {
                    exportedObjectStr = varDeclMatch[1];
                }
            }
        }

        if (!exportedObjectStr) {
            return {
                config: null,
                error: "Could not find `export default {...}` in config file",
            };
        }

        // Strip import references (component: SomeWidget) that vm can't resolve
        // Replace component references with a placeholder string
        const sanitized = exportedObjectStr.replace(
            /component\s*:\s*([A-Z][a-zA-Z0-9_$]*)/g,
            'component: "$1"'
        );

        const context = vm.createContext({ module: { exports: {} } });

        try {
            vm.runInContext(`module.exports = ${sanitized}`, context);
        } catch (vmErr) {
            // Most common cause: config references a component import that
            // can't be resolved outside the bundled runtime.
            return {
                config: null,
                error: `vm eval error: ${vmErr.message} (likely a component import reference — structure may still be valid)`,
            };
        }

        return { config: context.module.exports, error: null };
    } catch (err) {
        return { config: null, error: err.message };
    }
}

// ---------------------------------------------------------------------------
// Full validation (ZIP download, extraction, structure + config checks)
// ---------------------------------------------------------------------------

/**
 * Resolve {version} and {name} placeholders in a download URL template.
 */
function resolveDownloadUrl(urlTemplate, version, name) {
    if (!urlTemplate) return null;
    let url = urlTemplate;
    url = url.replace(/\{version\}/g, version);
    url = url.replace(/\{name\}/g, name);
    return url;
}

/**
 * Find the "real root" of an extracted ZIP.
 * If the ZIP has a single top-level directory wrapping everything, descend
 * into it so validation can find package.json and widgets/.
 */
function findWidgetRoot(extractedDir) {
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true });

    // Check if current dir looks like a widget root
    const hasPackageJson = entries.some(
        (e) =>
            e.isFile() && (e.name === "package.json" || e.name === "dash.json")
    );
    const hasWidgetsDir = entries.some(
        (e) => e.isDirectory() && e.name === "widgets"
    );

    if (hasPackageJson || hasWidgetsDir) {
        return extractedDir;
    }

    // If there's exactly one subdirectory, recurse into it
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1) {
        return findWidgetRoot(path.join(extractedDir, dirs[0].name));
    }

    return extractedDir;
}

/**
 * Run full validation: download ZIP, extract, validate structure + configs.
 *
 * @param {Object} manifest - Parsed manifest object
 * @returns {Promise<{ errors: string[], warnings: string[] }>}
 */
async function validateFull(manifest) {
    const errors = [];
    const warnings = [];

    const resolvedUrl = resolveDownloadUrl(
        manifest.downloadUrl,
        manifest.version,
        manifest.name
    );

    if (!resolvedUrl) {
        errors.push("Could not resolve downloadUrl");
        return { errors, warnings };
    }

    // ---  Download  ---
    let zipBuffer;
    try {
        const headers = {};
        if (process.env.GITHUB_TOKEN) {
            headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
        }
        const response = await fetch(resolvedUrl, { headers });
        if (!response.ok) {
            if (response.status === 404) {
                warnings.push(
                    `ZIP not found at ${resolvedUrl} (HTTP 404). The release may not be published yet.`
                );
                return { errors, warnings };
            }
            errors.push(
                `Failed to download ZIP: HTTP ${response.status} ${response.statusText}`
            );
            return { errors, warnings };
        }
        zipBuffer = Buffer.from(await response.arrayBuffer());
    } catch (fetchErr) {
        warnings.push(
            `Could not fetch ZIP at ${resolvedUrl}: ${fetchErr.message}`
        );
        return { errors, warnings };
    }

    // ---  Extract  ---
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "dash-validate-widget-")
    );

    try {
        const AdmZip = require("adm-zip");
        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(tmpDir, true);
    } catch (zipErr) {
        errors.push(`Failed to extract ZIP: ${zipErr.message}`);
        cleanup(tmpDir);
        return { errors, warnings };
    }

    const widgetRoot = findWidgetRoot(tmpDir);

    // ---  Structure checks  ---
    const hasPackageJson = fs.existsSync(path.join(widgetRoot, "package.json"));
    const hasDashJson = fs.existsSync(path.join(widgetRoot, "dash.json"));
    if (!hasPackageJson && !hasDashJson) {
        errors.push(
            "ZIP must contain package.json or dash.json at the root level"
        );
    }

    const widgetsDir = path.join(widgetRoot, "widgets");
    if (!fs.existsSync(widgetsDir)) {
        errors.push("ZIP must contain a widgets/ directory");
        cleanup(tmpDir);
        return { errors, warnings };
    }

    // ---  Discover .dash.js files  ---
    const files = fs.readdirSync(widgetsDir);
    const dashFiles = files.filter((f) => f.endsWith(".dash.js"));
    const jsFiles = files.filter(
        (f) => f.endsWith(".js") && !f.endsWith(".dash.js")
    );

    if (dashFiles.length === 0) {
        errors.push(
            "widgets/ directory must contain at least one .dash.js config file"
        );
        cleanup(tmpDir);
        return { errors, warnings };
    }

    // Check for matching component files
    for (const dashFile of dashFiles) {
        const baseName = dashFile.replace(".dash.js", "");
        const componentFile = `${baseName}.js`;
        if (!jsFiles.includes(componentFile)) {
            warnings.push(
                `Config ${dashFile} has no matching component file ${componentFile}`
            );
        }
    }

    // ---  Parse each .dash.js config  ---
    const discoveredNames = [];
    for (const dashFile of dashFiles) {
        const configPath = path.join(widgetsDir, dashFile);
        const { config, error } = parseDashConfig(configPath);

        if (error) {
            if (error.includes("component import reference")) {
                warnings.push(`${dashFile}: ${error}`);
            } else {
                errors.push(`${dashFile}: ${error}`);
            }
            continue;
        }

        if (config && config.name) {
            discoveredNames.push(config.name);
        } else {
            const baseName = dashFile.replace(".dash.js", "");
            discoveredNames.push(baseName);
        }
    }

    // ---  Cross-check manifest widgets vs discovered configs  ---
    if (manifest.widgets && discoveredNames.length > 0) {
        const manifestNames = manifest.widgets.map((w) => w.name);
        for (const mName of manifestNames) {
            if (!discoveredNames.includes(mName)) {
                warnings.push(
                    `Manifest widget "${mName}" not found in ZIP .dash.js configs (found: ${discoveredNames.join(
                        ", "
                    )})`
                );
            }
        }
        for (const dName of discoveredNames) {
            if (!manifestNames.includes(dName)) {
                warnings.push(
                    `ZIP config "${dName}" is not listed in manifest widgets array`
                );
            }
        }
    }

    cleanup(tmpDir);
    return { errors, warnings };
}

/**
 * Remove a temporary directory, ignoring errors.
 */
function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // best effort
    }
}

// ---------------------------------------------------------------------------
// Package validation (pre-build and post-build checks)
// ---------------------------------------------------------------------------

/**
 * Validate widget source files before building.
 * Checks .dash.js configs, matching component files, and package.json.
 *
 * @param {string} widgetsDir - Path to src/Widgets/ directory
 * @param {Object} packageJson - Parsed package.json object
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validatePackage(widgetsDir, packageJson) {
    const errors = [];
    const warnings = [];

    // --- package.json checks ---
    if (!packageJson.name) {
        errors.push('package.json is missing required "name" field');
    }
    if (!packageJson.version) {
        errors.push('package.json is missing required "version" field');
    }

    if (!fs.existsSync(widgetsDir)) {
        errors.push(`Widgets directory not found: ${widgetsDir}`);
        return { errors, warnings };
    }

    // Collect all .dash.js configs recursively
    function collectConfigs(dir) {
        const results = [];
        if (!fs.existsSync(dir)) return results;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...collectConfigs(fullPath));
            } else if (entry.name.endsWith(".dash.js")) {
                results.push(fullPath);
            }
        }
        return results;
    }

    const configPaths = collectConfigs(widgetsDir);

    if (configPaths.length === 0) {
        errors.push("No .dash.js config files found in widgets directory");
        return { errors, warnings };
    }

    const widgetNames = [];

    for (const configPath of configPaths) {
        const fileName = path.basename(configPath, ".dash.js");
        const configDir = path.dirname(configPath);

        // Parse the config
        const { config, error } = parseDashConfig(configPath);

        if (error) {
            if (error.includes("component import reference")) {
                // Config references component import — check fields via regex instead
                const source = fs.readFileSync(configPath, "utf8");
                const hasName = /name\s*:\s*["']/.test(source);
                const hasDisplayName = /displayName\s*:\s*["']/.test(source);
                const hasType = /type\s*:\s*["']/.test(source);
                if (!hasName)
                    warnings.push(`${fileName}.dash.js: missing "name" field`);
                if (!hasDisplayName)
                    warnings.push(
                        `${fileName}.dash.js: missing "displayName" field`
                    );
                if (!hasType)
                    warnings.push(`${fileName}.dash.js: missing "type" field`);
            } else {
                errors.push(`${fileName}.dash.js: ${error}`);
                continue;
            }
        }

        if (config) {
            // Required fields
            if (!config.name) {
                errors.push(
                    `${fileName}.dash.js: missing required "name" field`
                );
            }
            if (!config.displayName) {
                errors.push(
                    `${fileName}.dash.js: missing required "displayName" field`
                );
            }
            if (!config.type) {
                errors.push(
                    `${fileName}.dash.js: missing required "type" field`
                );
            }

            // Track names for duplicate detection
            const widgetName = config.name || fileName;
            widgetNames.push({ name: widgetName, file: configPath });
        }

        // Check for matching component .js file
        const componentFile = path.join(configDir, `${fileName}.js`);
        if (!fs.existsSync(componentFile)) {
            warnings.push(
                `${fileName}.dash.js has no matching component file ${fileName}.js`
            );
        }
    }

    // Check for duplicate widget names
    const nameCount = {};
    for (const { name, file } of widgetNames) {
        if (nameCount[name]) {
            errors.push(
                `Duplicate widget name "${name}" found in ${path.basename(
                    nameCount[name]
                )} and ${path.basename(file)}`
            );
        } else {
            nameCount[name] = file;
        }
    }

    return { errors, warnings };
}

/**
 * Validate a built ZIP file for structure and size.
 *
 * @param {string} zipPath - Path to the ZIP file
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateZip(zipPath) {
    const errors = [];
    const warnings = [];

    if (!fs.existsSync(zipPath)) {
        errors.push(`ZIP file not found: ${zipPath}`);
        return { errors, warnings };
    }

    const stats = fs.statSync(zipPath);
    const sizeMB = stats.size / (1024 * 1024);

    // Size checks
    if (sizeMB > 50) {
        errors.push(
            `ZIP file is too large: ${sizeMB.toFixed(1)} MB (max 50 MB)`
        );
    } else if (sizeMB > 5) {
        warnings.push(`ZIP file is large: ${sizeMB.toFixed(1)} MB (> 5 MB)`);
    }

    // Structure checks
    try {
        const AdmZip = require("adm-zip");
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries().map((e) => e.entryName);

        // Check for dash.json
        if (!entries.includes("dash.json")) {
            errors.push("ZIP is missing dash.json");
        }

        // Check for configs/ directory
        const hasConfigs = entries.some((e) => e.startsWith("configs/"));
        if (!hasConfigs) {
            errors.push("ZIP is missing configs/ directory");
        }

        // Check for bundled JS files
        const hasBundle = entries.some(
            (e) =>
                (e.endsWith(".cjs.js") || e.endsWith(".mjs")) &&
                !e.startsWith("configs/")
        );
        if (!hasBundle) {
            warnings.push(
                "ZIP does not contain any bundled JS files (.cjs.js or .mjs)"
            );
        }

        // Cross-check dash.json widgets vs config files
        const dashJsonEntry = zip.getEntry("dash.json");
        if (dashJsonEntry) {
            try {
                const dashJson = JSON.parse(
                    dashJsonEntry.getData().toString("utf8")
                );
                if (dashJson.widgets && Array.isArray(dashJson.widgets)) {
                    const configFiles = entries
                        .filter(
                            (e) =>
                                e.startsWith("configs/") &&
                                e.endsWith(".dash.js")
                        )
                        .map((e) => path.basename(e, ".dash.js"));

                    for (const widget of dashJson.widgets) {
                        if (widget.name && !configFiles.includes(widget.name)) {
                            warnings.push(
                                `dash.json widget "${widget.name}" has no matching config file in configs/`
                            );
                        }
                    }
                }
            } catch {
                errors.push("dash.json is not valid JSON");
            }
        }
    } catch (zipErr) {
        errors.push(`Failed to read ZIP: ${zipErr.message}`);
    }

    return { errors, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[36m";

async function main() {
    const args = process.argv.slice(2);
    const flags = args.filter((a) => a.startsWith("--"));
    const positional = args.filter((a) => !a.startsWith("--"));

    const isFull = flags.includes("--full");
    const isJson = flags.includes("--json");
    const isPackage = flags.includes("--package");

    // --- Package validation mode ---
    if (isPackage) {
        const ROOT = path.resolve(__dirname, "..");
        const widgetsDir = path.join(ROOT, "src", "Widgets");
        const pkgPath = path.join(ROOT, "package.json");

        if (!fs.existsSync(pkgPath)) {
            console.error(`${RED}ERROR: package.json not found${RESET}`);
            process.exit(1);
        }

        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        console.log(
            `\n${BLUE}Validating package: ${pkg.name || "unknown"}${RESET}\n`
        );

        const result = validatePackage(widgetsDir, pkg);

        if (result.errors.length > 0) {
            for (const e of result.errors) {
                console.log(`  ${RED}ERROR: ${e}${RESET}`);
            }
        }
        if (result.warnings.length > 0) {
            for (const w of result.warnings) {
                console.log(`  ${YELLOW}WARNING: ${w}${RESET}`);
            }
        }

        console.log("");

        if (result.errors.length === 0 && result.warnings.length === 0) {
            console.log(`${GREEN}PASSED — package validation passed${RESET}`);
        } else if (result.errors.length === 0) {
            console.log(
                `${YELLOW}PASSED with ${result.warnings.length} warning(s)${RESET}`
            );
        } else {
            console.log(
                `${RED}FAILED — ${result.errors.length} error(s), ${result.warnings.length} warning(s)${RESET}`
            );
        }

        process.exit(result.errors.length > 0 ? 1 : 0);
        return;
    }

    // --- Manifest validation mode ---
    if (positional.length === 0) {
        console.error(
            "Usage:\n" +
                "  node scripts/validateWidget.cjs <manifest.json> [--full] [--json]\n" +
                "  node scripts/validateWidget.cjs --package"
        );
        process.exit(1);
    }

    const manifestPath = path.resolve(positional[0]);

    if (!fs.existsSync(manifestPath)) {
        const msg = `Manifest file not found: ${manifestPath}`;
        if (isJson) {
            console.log(
                JSON.stringify({ passed: false, errors: [msg], warnings: [] })
            );
        } else {
            console.error(`${RED}ERROR: ${msg}${RESET}`);
        }
        process.exit(1);
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (parseErr) {
        const msg = `Invalid JSON in manifest: ${parseErr.message}`;
        if (isJson) {
            console.log(
                JSON.stringify({ passed: false, errors: [msg], warnings: [] })
            );
        } else {
            console.error(`${RED}ERROR: ${msg}${RESET}`);
        }
        process.exit(1);
    }

    // --- Schema validation ---
    const schema = validateManifestSchema(manifest);
    let allErrors = [...schema.errors];
    let allWarnings = [...schema.warnings];

    // --- Full validation ---
    if (isFull && schema.errors.length === 0) {
        const full = await validateFull(manifest);
        allErrors.push(...full.errors);
        allWarnings.push(...full.warnings);
    } else if (isFull && schema.errors.length > 0) {
        allWarnings.push("Skipping full validation because schema has errors");
    }

    // --- Output ---
    if (isJson) {
        const result = {
            passed: allErrors.length === 0,
            errors: allErrors,
            warnings: allWarnings,
        };
        console.log(JSON.stringify(result, null, 2));
    } else {
        if (!isJson) {
            console.log(`\n${BLUE}Validating: ${manifestPath}${RESET}`);
            console.log(
                `${BLUE}Mode: ${
                    isFull ? "full (schema + ZIP)" : "schema only"
                }${RESET}\n`
            );
        }

        if (allErrors.length > 0) {
            for (const e of allErrors) {
                console.log(`  ${RED}ERROR: ${e}${RESET}`);
            }
        }
        if (allWarnings.length > 0) {
            for (const w of allWarnings) {
                console.log(`  ${YELLOW}WARNING: ${w}${RESET}`);
            }
        }

        console.log("");

        if (allErrors.length === 0 && allWarnings.length === 0) {
            console.log(`${GREEN}PASSED — manifest is valid${RESET}`);
        } else if (allErrors.length === 0) {
            console.log(
                `${YELLOW}PASSED with ${allWarnings.length} warning(s)${RESET}`
            );
        } else {
            console.log(
                `${RED}FAILED — ${allErrors.length} error(s), ${allWarnings.length} warning(s)${RESET}`
            );
        }
    }

    // Exit codes: 0 = passed, 1 = errors, 2 = warnings only
    if (allErrors.length > 0) {
        process.exit(1);
    } else if (allWarnings.length > 0) {
        process.exit(2);
    } else {
        process.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Exports (for programmatic use by publishToRegistry.js)
// ---------------------------------------------------------------------------

module.exports = {
    validateManifestSchema,
    validateFull,
    parseDashConfig,
    validatePackage,
    validateZip,
};

// Run CLI if invoked directly
if (require.main === module) {
    main().catch((err) => {
        console.error(`Fatal: ${err.message}`);
        process.exit(1);
    });
}
