#!/usr/bin/env node

/**
 * publishToRegistry.js
 *
 * Automates publishing widget packages to the dash-registry.
 *
 * What it does:
 * 1. Scans src/Widgets/ for all .dash.js config files
 * 2. Reads metadata from each (name, author, description, icon, version, providers, etc.)
 * 3. Detects GitHub username via cascade (cached → gh CLI → GitHub API → git remote → prompt)
 * 4. Stamps scoped widget IDs: {githubUser}.{package}.{widgetName}
 * 5. Generates a manifest.json conforming to the registry schema
 * 6. Uploads ZIP to trops/dash-registry releases (no separate repo required)
 * 7. Uses `gh` CLI to fork dash-registry, create a branch, write manifest, and open a PR
 *
 * Prerequisites:
 * - `gh` CLI installed and authenticated (`gh auth login`)
 * - `npm run package-zip` script available
 *
 * Usage:
 *   npm run publish-to-registry
 *   npm run publish-to-registry -- --dry-run        # Preview manifest without opening PR
 *   npm run publish-to-registry -- --name custom     # Custom registry name
 *   npm run publish-to-registry -- --github-user me  # Override GitHub username
 *   npm run publish-to-registry -- --package Clock   # Publish specific package (monorepo)
 *   npm run publish-to-registry -- --all             # Publish all packages (monorepo)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const WIDGETS_DIR = path.join(ROOT, "src", "Widgets");
const REGISTRY_REPO = "trops/dash-registry";

// Folders to skip when scanning for publishable widget packages
const EXCLUDED_DIRS = new Set(["DashSamples"]);

const GITHUB_USER_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const GENERIC_USERNAMES = new Set([
    "your name",
    "username",
    "user",
    "root",
    "admin",
    "",
]);

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const nameIdx = args.indexOf("--name");
const customName = nameIdx !== -1 ? args[nameIdx + 1] : null;
const ghUserIdx = args.indexOf("--github-user");
const ghUserOverride = ghUserIdx !== -1 ? args[ghUserIdx + 1] : null;
const packageIdx = args.indexOf("--package");
const targetPackage = packageIdx !== -1 ? args[packageIdx + 1] : null;
const publishAll = args.includes("--all");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toKebabCase(str) {
    return str
        .trim()
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

function toTitleCase(kebab) {
    return kebab
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

function exec(cmd) {
    try {
        return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
    } catch (error) {
        return null;
    }
}

function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// ---------------------------------------------------------------------------
// Config collection and parsing
// ---------------------------------------------------------------------------

function collectDashConfigs(dir) {
    const configs = [];
    if (!fs.existsSync(dir)) return configs;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            configs.push(...collectDashConfigs(fullPath));
        } else if (entry.name.endsWith(".dash.js")) {
            configs.push(fullPath);
        }
    }
    return configs;
}

function parseDashConfig(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    const fileName = path.basename(filePath, ".dash.js");

    const extract = (key) => {
        const patterns = [
            new RegExp(`${key}\\s*:\\s*"([^"]*)"`, "m"),
            new RegExp(`${key}\\s*:\\s*'([^']*)'`, "m"),
        ];
        for (const pattern of patterns) {
            const match = content.match(pattern);
            if (match) return match[1];
        }
        return null;
    };

    const extractTopLevel = (key) => {
        // Remove userConfig block to avoid matching nested displayName fields
        const stripped = content.replace(
            /userConfig\s*:\s*\{[\s\S]*?\n    \},?/m,
            ""
        );
        const patterns = [
            new RegExp(`${key}\\s*:\\s*"([^"]*)"`, "m"),
            new RegExp(`${key}\\s*:\\s*'([^']*)'`, "m"),
        ];
        for (const pattern of patterns) {
            const match = stripped.match(pattern);
            if (match) return match[1];
        }
        return null;
    };

    const typeMatch = content.match(/type\s*:\s*["'](\w+)["']/);
    const type = typeMatch ? typeMatch[1] : "widget";

    let providers = [];
    const providersMatch = content.match(/providers\s*:\s*\[([\s\S]*?)\]/m);
    if (providersMatch) {
        const providerBlock = providersMatch[1];
        const typeMatches = providerBlock.match(/type\s*:\s*["']([^"']+)["']/g);
        const requiredMatches = providerBlock.match(
            /required\s*:\s*(true|false)/g
        );
        if (typeMatches) {
            typeMatches.forEach((t, i) => {
                const provType = t.match(/["']([^"']+)["']/)[1];
                const req =
                    requiredMatches && requiredMatches[i]
                        ? requiredMatches[i].includes("true")
                        : false;
                providers.push({ type: provType, required: req });
            });
        }
    }

    return {
        name: fileName,
        displayName: extractTopLevel("displayName") || fileName,
        description: extract("description") || "",
        icon: extract("icon") || null,
        type,
        providers,
        package: extract("package") || null,
    };
}

// ---------------------------------------------------------------------------
// GitHub username detection cascade
// ---------------------------------------------------------------------------

/**
 * Detect the GitHub username via a prioritized cascade:
 * 1. --github-user CLI flag
 * 2. Cached value in package.json "dash.githubUser"
 * 3. gh CLI: `gh api user --jq .login`
 * 4. GitHub API + PAT: curl with $GITHUB_TOKEN
 * 5. Git remote URL: parse owner from github.com:{owner}/repo
 * 6. Interactive prompt
 *
 * After detection, verifies the username exists on GitHub.
 * Caches the result in package.json under "dash.githubUser".
 */
async function detectGithubUser(pkg, pkgPath) {
    let githubUser = null;
    let source = null;

    // 1. CLI override
    if (ghUserOverride) {
        githubUser = ghUserOverride;
        source = "--github-user flag";
    }

    // 2. Cached value in package.json
    if (!githubUser && pkg.dash && pkg.dash.githubUser) {
        githubUser = pkg.dash.githubUser;
        source = "package.json dash.githubUser (cached)";
    }

    // 3. gh CLI
    if (!githubUser) {
        const ghLogin = exec("gh api user --jq .login 2>/dev/null");
        if (ghLogin) {
            githubUser = ghLogin;
            source = "gh CLI (gh api user)";
        }
    }

    // 4. GitHub API + PAT
    if (!githubUser && process.env.GITHUB_TOKEN) {
        const apiResult = exec(
            `curl -s -H "Authorization: token ${process.env.GITHUB_TOKEN}" https://api.github.com/user 2>/dev/null`
        );
        if (apiResult) {
            try {
                const userData = JSON.parse(apiResult);
                if (userData.login) {
                    githubUser = userData.login;
                    source = "GitHub API (GITHUB_TOKEN)";
                }
            } catch {
                // Ignore parse errors
            }
        }
    }

    // 5. Git remote URL
    if (!githubUser) {
        const remoteUrl = exec("git remote get-url origin 2>/dev/null");
        if (remoteUrl) {
            // Match github.com:{owner}/repo or github.com/{owner}/repo
            const match = remoteUrl.match(/github\.com[:/]([^/]+)\//);
            if (match) {
                const candidate = match[1];
                console.log(
                    `\nDetected GitHub user "${candidate}" from git remote URL.`
                );
                const confirm = await prompt(
                    `Is "${candidate}" your GitHub username? (y/n): `
                );
                if (
                    confirm.toLowerCase() === "y" ||
                    confirm.toLowerCase() === "yes"
                ) {
                    githubUser = candidate;
                    source = "git remote URL";
                }
            }
        }
    }

    // 6. Interactive prompt
    if (!githubUser) {
        githubUser = await prompt("Enter your GitHub username: ");
        source = "interactive prompt";
    }

    // Validation
    if (!githubUser || GENERIC_USERNAMES.has(githubUser.toLowerCase())) {
        console.error(`Error: Invalid GitHub username: "${githubUser || ""}"`);
        process.exit(1);
    }

    if (!GITHUB_USER_RE.test(githubUser)) {
        console.error(
            `Error: GitHub username "${githubUser}" doesn't match expected format (letters, digits, hyphens).`
        );
        process.exit(1);
    }

    // Verify the account exists on GitHub
    if (!isDryRun) {
        const verifyResult = exec(
            `curl -s -o /dev/null -w "%{http_code}" https://api.github.com/users/${githubUser}`
        );
        if (verifyResult !== "200") {
            console.error(
                `Error: GitHub user "${githubUser}" not found (HTTP ${verifyResult}).`
            );
            process.exit(1);
        }
    }

    console.log(`GitHub user: ${githubUser} (via ${source})`);

    // Cache in package.json
    if (source !== "package.json dash.githubUser (cached)") {
        pkg.dash = pkg.dash || {};
        pkg.dash.githubUser = githubUser;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + "\n");
        console.log(`Cached githubUser "${githubUser}" in package.json`);
    }

    return githubUser;
}

// ---------------------------------------------------------------------------
// gh CLI checks
// ---------------------------------------------------------------------------

function checkGhCli() {
    const version = exec("gh --version");
    if (!version) {
        console.error("Error: `gh` CLI is not installed.");
        console.error("Install it: https://cli.github.com/");
        process.exit(1);
    }

    const authStatus = exec("gh auth status 2>&1");
    if (!authStatus || authStatus.includes("not logged")) {
        console.error("Error: `gh` CLI is not authenticated.");
        console.error("Run: gh auth login");
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Build and release
// ---------------------------------------------------------------------------

function buildAndRelease(githubUser, registryName, projectName, version) {
    const releaseTag = `${githubUser}--${registryName}--v${version}`;
    const zipName = `${projectName}-v${version}.zip`;

    // Always build a fresh ZIP
    console.log(`\nBuilding widget package...`);
    try {
        execSync("npm run package-zip", { cwd: ROOT, stdio: "inherit" });
    } catch {
        console.error("Error: Failed to build widget package.");
        process.exit(1);
    }

    const zipPath = path.join(ROOT, zipName);
    if (!fs.existsSync(zipPath)) {
        console.error(`Error: Expected ZIP not found at ${zipPath}`);
        process.exit(1);
    }

    // Upload ZIP to dash-registry releases (not the widget project's own repo)
    console.log(
        `\nUploading ${zipName} to ${REGISTRY_REPO} release ${releaseTag}...`
    );
    const createResult = exec(
        `gh release create "${releaseTag}" "${zipPath}" --repo ${REGISTRY_REPO} --title "${registryName} v${version}" --notes "Published by ${githubUser}" 2>&1`
    );

    if (createResult && !createResult.includes("already exists")) {
        console.log(`Release ${releaseTag} created on ${REGISTRY_REPO}.`);
        return releaseTag;
    }

    // Release already exists — replace the ZIP asset
    console.log(`Release ${releaseTag} exists. Replacing asset...`);
    const uploadResult = exec(
        `gh release upload "${releaseTag}" "${zipPath}" --repo ${REGISTRY_REPO} --clobber 2>&1`
    );
    if (!uploadResult || uploadResult.includes("error")) {
        console.error(
            "Error: Failed to upload ZIP to existing release on dash-registry."
        );
        console.error(uploadResult);
        process.exit(1);
    }

    console.log(
        `Release ${releaseTag} updated with fresh ${zipName} on ${REGISTRY_REPO}.`
    );
    return releaseTag;
}

// ---------------------------------------------------------------------------
// Monorepo support — discover publishable widget folders
// ---------------------------------------------------------------------------

function discoverWidgetFolders() {
    if (!fs.existsSync(WIDGETS_DIR)) return [];

    const entries = fs.readdirSync(WIDGETS_DIR, { withFileTypes: true });
    return entries
        .filter((e) => e.isDirectory() && !EXCLUDED_DIRS.has(e.name))
        .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    // Read package.json
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const projectName = (pkg.name || "widgets").replace(/^@[^/]+\//, "");
    const version = pkg.version || "0.0.0";
    const author =
        typeof pkg.author === "string" ? pkg.author : pkg.author?.name || "";
    const repository =
        typeof pkg.repository === "string"
            ? pkg.repository
            : pkg.repository?.url || "";

    // Check for excluded dirs configuration
    if (pkg.dash && Array.isArray(pkg.dash.exclude)) {
        for (const excl of pkg.dash.exclude) {
            EXCLUDED_DIRS.add(excl);
        }
    }

    // Detect GitHub username via cascade
    const githubUser = await detectGithubUser(pkg, pkgPath);

    // Discover widget folders for monorepo support
    const widgetFolders = discoverWidgetFolders();

    if (widgetFolders.length === 0) {
        console.error("Error: No widget folders found in src/Widgets/");
        process.exit(1);
    }

    // Determine which folders to publish
    let foldersToPublish = widgetFolders;
    if (targetPackage) {
        if (!widgetFolders.includes(targetPackage)) {
            console.error(
                `Error: Package "${targetPackage}" not found. Available: ${widgetFolders.join(
                    ", "
                )}`
            );
            process.exit(1);
        }
        foldersToPublish = [targetPackage];
    } else if (!publishAll && widgetFolders.length > 1) {
        console.log(
            `\nMultiple widget folders found: ${widgetFolders.join(", ")}`
        );
        console.log(
            "Use --package <name> to publish one, or --all to publish all."
        );
        const answer = await prompt(
            `Publish all ${widgetFolders.length} packages? (y/n): `
        );
        if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
            console.log("Aborted.");
            process.exit(0);
        }
    }

    // Publish each folder
    for (const folderName of foldersToPublish) {
        const folderPath = path.join(WIDGETS_DIR, folderName);
        await publishPackage(
            folderName,
            folderPath,
            githubUser,
            pkg,
            projectName,
            version,
            author,
            repository
        );
    }

    console.log(
        "\nDone! Your widgets will appear in the Discover tab once the PR is merged."
    );
}

async function publishPackage(
    folderName,
    folderPath,
    githubUser,
    pkg,
    projectName,
    version,
    author,
    repository
) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Publishing: ${folderName}`);
    console.log("=".repeat(60));

    // Collect widget configs for this folder
    const dashConfigPaths = collectDashConfigs(folderPath);
    const widgets = [];

    for (const configPath of dashConfigPaths) {
        const config = parseDashConfig(configPath);
        if (config.type === "widget") {
            widgets.push({
                name: config.name,
                displayName: config.displayName,
                description: config.description,
                icon: config.icon,
                providers: config.providers,
                package: config.package,
            });
        }
    }

    if (widgets.length === 0) {
        console.warn(`Warning: No widgets found in ${folderName}, skipping.`);
        return;
    }

    // ── Resolve registryName / registryDisplayName ──────────────────

    // Default: folder name (zero config)
    let registryName = toKebabCase(folderName);
    let registryDisplayName = toTitleCase(registryName);

    // Override: .dash.js package field (if consistent across all widgets)
    const packageNames = [
        ...new Set(widgets.map((w) => w.package).filter(Boolean)),
    ];
    if (packageNames.length === 1) {
        registryDisplayName = packageNames[0];
        registryName = toKebabCase(packageNames[0]);
    } else if (packageNames.length > 1) {
        console.warn(
            `Warning: Multiple package names in configs: ${packageNames.join(
                ", "
            )}`
        );
    }

    // Override: --name flag (always wins)
    if (customName) {
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(customName)) {
            console.error(
                `Error: --name must be kebab-case (got "${customName}").`
            );
            process.exit(1);
        }
        registryName = customName;
        registryDisplayName = toTitleCase(customName);
    }

    // Stamp scoped widget IDs and strip internal "package" field
    const manifestWidgets = widgets.map(({ package: _pkg, ...rest }) => ({
        id: `${githubUser}.${registryName}.${rest.name}`,
        ...rest,
    }));

    // Infer category from tags or default
    const category = "general";

    // Build download URL pointing to dash-registry releases
    const releaseTag = `${githubUser}--${registryName}--v{version}`;
    const downloadUrl = `https://github.com/${REGISTRY_REPO}/releases/download/${releaseTag}/${projectName}-v{version}.zip`;

    // Repository is optional
    const repoUrl = repository ? repository.replace(/\.git$/, "") : "";

    // Generate manifest
    const manifest = {
        githubUser: githubUser,
        name: registryName,
        displayName: registryDisplayName,
        author: author,
        description: pkg.description || "",
        version: version,
        category: category,
        tags: pkg.keywords || [],
        downloadUrl: downloadUrl,
        ...(repoUrl ? { repository: repoUrl } : {}),
        publishedAt: new Date().toISOString(),
        widgets: manifestWidgets,
    };

    console.log("\nGenerated manifest:");
    console.log(JSON.stringify(manifest, null, 2));
    console.log(
        `\nWidgets: ${manifestWidgets
            .map((w) => `${w.name} (${w.id})`)
            .join(", ")}`
    );

    // Pre-flight schema validation
    const { validateManifestSchema } = require("./validateWidget.cjs");
    const { errors: schemaErrors, warnings: schemaWarnings } =
        validateManifestSchema(manifest);

    if (schemaErrors.length > 0) {
        console.error("\nManifest validation failed:");
        schemaErrors.forEach((e) => console.error(`  ERROR: ${e}`));
        schemaWarnings.forEach((w) => console.warn(`  WARNING: ${w}`));
        process.exit(1);
    }
    if (schemaWarnings.length > 0) {
        console.warn("\nManifest validation warnings:");
        schemaWarnings.forEach((w) => console.warn(`  WARNING: ${w}`));
    } else {
        console.log("\nManifest schema validation passed.");
    }

    if (isDryRun) {
        console.log("\n[Dry run] No PR will be created.");
        return;
    }

    // Check gh CLI (needed for release upload and PR creation)
    checkGhCli();

    // Build fresh ZIP and upload to dash-registry releases
    buildAndRelease(githubUser, registryName, projectName, version);

    console.log("\nPublishing to dash-registry...");

    // Fork the registry repo (idempotent)
    console.log(`Forking ${REGISTRY_REPO}...`);
    exec(`gh repo fork ${REGISTRY_REPO} --clone=false 2>&1`);

    const branchName = `add-${registryName}`;
    const manifestPath = `packages/${githubUser}/${registryName}/manifest.json`;
    const manifestContent = JSON.stringify(manifest, null, 2);

    // Create the manifest file via the GitHub API
    console.log(`Creating ${manifestPath} on branch ${branchName}...`);

    // Get the default branch SHA
    const defaultBranch =
        exec(
            `gh api repos/${githubUser}/dash-registry --jq .default_branch 2>&1`
        ) || "main";
    const baseSha = exec(
        `gh api repos/${githubUser}/dash-registry/git/ref/heads/${defaultBranch} --jq .object.sha 2>&1`
    );

    if (!baseSha) {
        console.error(
            "Error: Could not get base SHA. Make sure the fork exists."
        );
        process.exit(1);
    }

    // Create branch
    exec(
        `gh api repos/${githubUser}/dash-registry/git/refs -f ref=refs/heads/${branchName} -f sha=${baseSha} 2>&1`
    );

    // Write manifest file via Contents API
    const encodedContent = Buffer.from(manifestContent).toString("base64");
    const createResult = exec(
        `gh api repos/${githubUser}/dash-registry/contents/${manifestPath} \
        -X PUT \
        -f message="Add ${registryName} v${version}" \
        -f content="${encodedContent}" \
        -f branch="${branchName}" 2>&1`
    );

    if (!createResult || createResult.includes("error")) {
        // File might already exist, try updating
        const existingSha = exec(
            `gh api repos/${githubUser}/dash-registry/contents/${manifestPath}?ref=${branchName} --jq .sha 2>&1`
        );
        if (existingSha && !existingSha.includes("Not Found")) {
            exec(
                `gh api repos/${githubUser}/dash-registry/contents/${manifestPath} \
                -X PUT \
                -f message="Update ${registryName} to v${version}" \
                -f content="${encodedContent}" \
                -f branch="${branchName}" \
                -f sha="${existingSha}" 2>&1`
            );
        }
    }

    // Create PR
    console.log("Opening pull request...");
    const prTitle = `Add ${manifest.displayName} v${version}`;
    const prBody = `## New Package: ${manifest.displayName}

**Author:** ${author}
**GitHub User:** ${githubUser}
**Version:** ${version}
**Widgets:** ${manifestWidgets
        .map((w) => `${w.displayName || w.name} (\`${w.id}\`)`)
        .join(", ")}

${manifest.description}

---
*Auto-generated by \`npm run publish-to-registry\`*`;

    const prResult = exec(
        `gh pr create \
        --repo ${REGISTRY_REPO} \
        --head ${githubUser}:${branchName} \
        --title "${prTitle}" \
        --body "${prBody.replace(/"/g, '\\"')}" 2>&1`
    );

    if (prResult && prResult.includes("github.com")) {
        console.log(`\nPull request created: ${prResult}`);
    } else {
        console.log(
            "\nPR may already exist or was created. Check:",
            `https://github.com/${REGISTRY_REPO}/pulls`
        );
    }
}

main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
