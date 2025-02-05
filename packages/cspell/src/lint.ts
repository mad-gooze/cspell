import type { CSpellReporter, CSpellSettings, Glob, Issue, RunResult, TextDocumentOffset } from '@cspell/cspell-types';
import { MessageTypes } from '@cspell/cspell-types';
import * as commentJson from 'comment-json';
import type { GlobMatcher, GlobPatternNormalized, GlobPatternWithRoot } from 'cspell-glob';
import type { ValidationIssue } from 'cspell-lib';
import * as cspell from 'cspell-lib';
import { Logger } from 'cspell-lib';
import * as path from 'path';
import { format } from 'util';
import { URI } from 'vscode-uri';
import { CSpellApplicationConfiguration } from './CSpellApplicationConfiguration';
import { ConfigInfo, FileInfo, fileInfoToDocument, findFiles, readConfig, readFileInfo } from './fileHelper';
import { toError } from './util/errors';
import { buildGlobMatcher, extractGlobsFromMatcher, extractPatterns, normalizeGlobsToRoot } from './util/glob';
import { loadReporters, mergeReporters } from './util/reporters';
import { measurePromise } from './util/timer';
import * as util from './util/util';

export interface FileResult {
    fileInfo: FileInfo;
    processed: boolean;
    issues: Issue[];
    errors: number;
    configErrors: number;
    elapsedTimeMs: number;
}

export async function runLint(cfg: CSpellApplicationConfiguration): Promise<RunResult> {
    let { reporter } = cfg;
    cspell.setLogger(getLoggerFromReporter(reporter));
    const configErrors = new Set<string>();

    const lintResult = await run();
    await reporter.result(lintResult);
    return lintResult;

    async function processFile(fileInfo: FileInfo, configInfo: ConfigInfo): Promise<FileResult> {
        const doc = fileInfoToDocument(fileInfo, cfg.options.languageId, cfg.locale);
        const { filename, text } = fileInfo;
        reporter.debug(`Filename: ${fileInfo.filename}, LanguageIds: ${doc.languageId ?? 'default'}`);
        const result: FileResult = {
            fileInfo,
            issues: [],
            processed: false,
            errors: 0,
            configErrors: 0,
            elapsedTimeMs: 0,
        };

        const startTime = Date.now();
        let spellResult: Partial<cspell.SpellCheckFileResult> = {};
        reporter.info(
            `Checking: ${filename}, File type: ${doc.languageId ?? 'auto'}, Language: ${doc.locale ?? 'default'}`,
            MessageTypes.Info
        );
        try {
            const validateOptions = { generateSuggestions: cfg.options.showSuggestions, numSuggestions: 5 };
            const r = await cspell.spellCheckDocument(doc, validateOptions, configInfo.config);
            spellResult = r;
            result.processed = r.checked;
            result.issues = cspell.Text.calculateTextDocumentOffsets(doc.uri, text, r.issues).map(mapIssue);
        } catch (e) {
            reporter.error(`Failed to process "${filename}"`, toError(e));
            result.errors += 1;
        }
        result.elapsedTimeMs = Date.now() - startTime;

        const config = spellResult.settingsUsed ?? {};

        result.configErrors += await reportConfigurationErrors(config);

        const debugCfg = { config: { ...config, source: null }, source: spellResult.localConfigFilepath };
        reporter.debug(commentJson.stringify(debugCfg, undefined, 2));
        const elapsed = result.elapsedTimeMs / 1000.0;
        const dictionaries = config.dictionaries || [];
        reporter.info(
            `Checked: ${filename}, File type: ${config.languageId}, Language: ${config.language} ... Issues: ${result.issues.length} ${elapsed}S`,
            MessageTypes.Info
        );
        reporter.info(`Config file Used: ${spellResult.localConfigFilepath || configInfo.source}`, MessageTypes.Info);
        reporter.info(`Dictionaries Used: ${dictionaries.join(', ')}`, MessageTypes.Info);
        return result;
    }

    function mapIssue(tdo: TextDocumentOffset & ValidationIssue): Issue {
        const context = cfg.showContext
            ? extractContext(tdo, cfg.showContext)
            : { text: tdo.line.text.trimEnd(), offset: tdo.line.offset };
        return { ...tdo, context };
    }

    /**
     * The file loader is written this way to cause files to be loaded in parallel while the previous one is being processed.
     * @param fileNames names of files to load one at a time.
     */
    function* fileLoader(fileNames: string[]) {
        for (const filename of fileNames) {
            const file = readFileInfo(filename);
            yield file;
        }
    }

    async function processFiles(
        files: Iterable<Promise<FileInfo>>,
        configInfo: ConfigInfo,
        fileCount: number
    ): Promise<RunResult> {
        const status: RunResult = runResult();
        let n = 0;
        for (const fileP of files) {
            ++n;
            const fileNum = n;
            const file = await fileP;
            const emitProgress = (elapsedTimeMs?: number, processed?: boolean, numErrors?: number) =>
                reporter.progress({
                    type: 'ProgressFileComplete',
                    fileNum,
                    fileCount,
                    filename: file.filename,
                    elapsedTimeMs,
                    processed,
                    numErrors,
                });
            if (!file.text) {
                emitProgress();
                continue;
            }
            const p = processFile(file, configInfo);
            const { elapsedTimeMs } = await measurePromise(p);
            const result = await p;
            emitProgress(elapsedTimeMs, result.processed, result.issues.length);
            // Show the spelling errors after emitting the progress.
            result.issues.filter(cfg.uniqueFilter).forEach((issue) => reporter.issue(issue));
            const r = await p;
            status.files += 1;
            if (r.issues.length || r.errors) {
                status.filesWithIssues.add(file.filename);
                status.issues += r.issues.length;
                status.errors += r.errors;
            }
            status.errors += r.configErrors;
        }

        return status;
    }

    async function reportConfigurationErrors(config: CSpellSettings): Promise<number> {
        const errors = cspell.extractImportErrors(config);
        let count = 0;
        errors.forEach((ref) => {
            const key = ref.error.toString();
            if (configErrors.has(key)) return;
            configErrors.add(key);
            count += 1;
            reporter.error('Configuration', ref.error);
        });

        const dictCollection = await cspell.getDictionary(config);
        dictCollection.dictionaries.forEach((dict) => {
            const dictErrors = dict.getErrors?.() || [];
            const msg = `Dictionary Error with (${dict.name})`;
            dictErrors.forEach((error) => {
                const key = msg + error.toString();
                if (configErrors.has(key)) return;
                configErrors.add(key);
                count += 1;
                reporter.error(msg, error);
            });
        });

        return count;
    }

    function countConfigErrors(configInfo: ConfigInfo): Promise<number> {
        return reportConfigurationErrors(configInfo.config);
    }

    async function run(): Promise<RunResult> {
        if (cfg.options.root) {
            process.env[cspell.ENV_CSPELL_GLOB_ROOT] = cfg.root;
        }

        const configInfo: ConfigInfo = await readConfig(cfg.configFile, cfg.root);
        reporter = mergeReporters(cfg.reporter, ...loadReporters(configInfo.config));
        cspell.setLogger(getLoggerFromReporter(reporter));

        const cliGlobs: Glob[] = cfg.files;
        const allGlobs: Glob[] = cliGlobs.length ? cliGlobs : configInfo.config.files || [];
        const combinedGlobs = normalizeGlobsToRoot(allGlobs, cfg.root, false);
        const cliExcludeGlobs = extractPatterns(cfg.excludes).map((p) => p.glob);
        const normalizedExcludes = normalizeGlobsToRoot(cliExcludeGlobs, cfg.root, true);
        const includeGlobs = combinedGlobs.filter((g) => !g.startsWith('!'));
        const excludeGlobs = combinedGlobs.filter((g) => g.startsWith('!')).concat(normalizedExcludes);
        const fileGlobs: string[] = includeGlobs;
        if (!fileGlobs.length) {
            // Nothing to do.
            return runResult();
        }
        header(fileGlobs, excludeGlobs);

        reporter.info(`Config Files Found:\n    ${configInfo.source}\n`, MessageTypes.Info);

        const configErrors = await countConfigErrors(configInfo);
        if (configErrors) return runResult({ errors: configErrors });

        // Get Exclusions from the config files.
        const { root } = cfg;
        const globsToExclude = (configInfo.config.ignorePaths || []).concat(excludeGlobs);
        const globMatcher = buildGlobMatcher(globsToExclude, root, true);
        const ignoreGlobs = extractGlobsFromMatcher(globMatcher);
        const globOptions = { root, cwd: root, ignore: ignoreGlobs.concat(normalizedExcludes) };
        const files = filterFiles(await findFiles(fileGlobs, globOptions), globMatcher);

        return processFiles(fileLoader(files), configInfo, files.length);
    }

    function header(files: string[], cliExcludes: string[]) {
        const formattedFiles = files.length > 100 ? files.slice(0, 100).concat(['...']) : files;

        reporter.info(
            `
cspell;
Date: ${new Date().toUTCString()}
Options:
    verbose:   ${yesNo(!!cfg.options.verbose)}
    config:    ${cfg.configFile || 'default'}
    exclude:   ${cliExcludes.join('\n               ')}
    files:     ${formattedFiles}
    wordsOnly: ${yesNo(!!cfg.options.wordsOnly)}
    unique:    ${yesNo(!!cfg.options.unique)}
`,
            MessageTypes.Info
        );
    }

    function isExcluded(filename: string, globMatcher: GlobMatcher) {
        if (cspell.isBinaryFile(URI.file(filename))) {
            return true;
        }
        const { root } = cfg;
        const absFilename = path.resolve(root, filename);
        const r = globMatcher.matchEx(absFilename);

        if (r.matched) {
            const { glob, source } = extractGlobSource(r.pattern);
            reporter.info(
                `Excluded File: ${path.relative(root, absFilename)}; Excluded by ${glob} from ${source}`,
                MessageTypes.Info
            );
        }

        return r.matched;
    }

    function extractGlobSource(g: GlobPatternWithRoot | GlobPatternNormalized) {
        const { glob, rawGlob, source } = <GlobPatternNormalized>g;
        return {
            glob: rawGlob || glob,
            source,
        };
    }

    function filterFiles(files: string[], globMatcher: GlobMatcher): string[] {
        const patterns = globMatcher.patterns;
        const excludeInfo = patterns.map(extractGlobSource).map(({ glob, source }) => `Glob: ${glob} from ${source}`);
        reporter.info(`Exclusion Globs: \n    ${excludeInfo.join('\n    ')}\n`, MessageTypes.Info);
        const result = files.filter(util.uniqueFn()).filter((filename) => !isExcluded(filename, globMatcher));
        return result;
    }
}

function extractContext(tdo: cspell.TextDocumentOffset, contextRange: number): cspell.TextOffset {
    const { line, offset } = tdo;
    const textOffsetInLine = offset - line.offset;
    let left = Math.max(textOffsetInLine - contextRange, 0);
    let right = Math.min(line.text.length, textOffsetInLine + contextRange + tdo.text.length);
    const lineText = line.text;

    const isLetter = /^[a-z]$/i;
    const isSpace = /^\s$/;

    for (let n = contextRange / 2; n > 0 && left > 0; n--, left--) {
        if (!isLetter.test(lineText[left - 1])) {
            break;
        }
    }

    for (let n = contextRange / 2; n > 0 && right < lineText.length; n--, right++) {
        if (!isLetter.test(lineText[right])) {
            break;
        }
    }

    // remove leading space
    for (; left < textOffsetInLine && isSpace.test(lineText[left]); left++) {
        /* do nothing */
    }

    const context = {
        text: line.text.slice(left, right).trimEnd(),
        offset: left + line.offset,
    };
    return context;
}

function runResult(init: Partial<RunResult> = {}): RunResult {
    const { files = 0, filesWithIssues = new Set<string>(), issues = 0, errors = 0 } = init;
    return { files, filesWithIssues, issues, errors };
}

function yesNo(value: boolean) {
    return value ? 'Yes' : 'No';
}

function getLoggerFromReporter(reporter: CSpellReporter): Logger {
    const log: Logger['log'] = (...params) => {
        const msg = format(...params);
        reporter.info(msg, 'Info');
    };

    const error: Logger['error'] = (...params) => {
        const msg = format(...params);
        const err = { message: '', name: 'error', toString: () => '' };
        reporter.error(msg, err);
    };
    const warn: Logger['warn'] = (...params) => {
        const msg = format(...params);
        reporter.info(msg, 'Warning');
    };

    return {
        log,
        warn,
        error,
    };
}
