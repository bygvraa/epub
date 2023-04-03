import fs from 'fs';
import path from 'path';
import JSZip from 'jszip'
import xml2js from 'xml2js';
import { JSDOM } from 'jsdom';
import * as utils from './utils';

/**
 * An interface for storing abbreviation key-value pairs
 */
interface AbbreviationMap {
    [abbreviation: string]: string
}

/**
 * An interface that contains stats about a book.
 */
export interface Analysis {
    file_bytes: number,
    lix: number;
    stats: AnalysisStats;
    items: SpineItemStats[];
}

interface AnalysisStats {
    found_lix?: number | null;
    generated_lix: number;
    word_count: number;
    long_word_count: number;
    sentence_count: number;
}

/**
 * An interface that references a spine item and all its text content.
 */
interface SpineItem {
    path: string;
    text_content: string;
}

/**
 * An interface that references a spine item and its stats.
 */
interface SpineItemStats extends ContentStats {
    name: string;
    generated_lix: number;
}

/**
 * An interface that references a spine item and its word/sentence content.
 */
interface SpineItemContent extends Content{
    name: string;
    generated_lix: number;
}

/**
 * An interface that holds stats about the word/sentence content of an item.
 */
interface ContentStats {
    word_count: number;
    long_word_count: number;
    sentence_count: number;
}

/**
 * An interface that contains the word/sentence content of an item.
 */
interface Content {
    words: string[];
    long_words: string[];
    sentences: string[]; 
}

// Load abbreviations file and export it as a constant
import ABBREVIATIONS_LIST from './abbreviations.json';

/**
 * Analyzes an EPUB file and returns statistics about its contents.
 * @param filePath The path to the EPUB file to analyze.
 * @throws An error if the provided file path is invalid or the file is not a valid EPUB.
 * @returns {Promise<Analysis>}
 */
export async function analyzeEpub(filePath: string): Promise<Analysis> {
    try {
        // Load zip
        const zip = await loadZip(filePath) as JSZip;

        // Find .opf content path
        const opfPath = await findOpfPath(zip) as string;

        // Load .opf content file and parse it as JSON
        const opfJson = await loadOpfJson(opfPath, zip) as any;

        // Get root path of the .opf content file
        const opfRoot = path.dirname(opfPath) as string;

        // Get paths of HTML content from EPUB file manifest
        //    The manifest contains a an unsorted list of every item in the EPUB
        const spineItemPaths = extractItemPathsFromManifest(opfJson, opfRoot) as string[];

        // Get HTML content from EPUB file spine
        //    The spine lists all XHTML content documents in a specific reading order
        const spineItems = await extractItemsFromSpine(spineItemPaths, zip) as SpineItem[];

        // Get stats from content
        const spineItemStats = await getSpineItemStats(spineItems) as SpineItemStats[];

        // Sum total amount of words, long words, and sentences
        const totalStats = getTotalStats(spineItemStats) as ContentStats;

        // Calculate median and mean LIX values
        const lixValues = spineItemStats.map(item => item.generated_lix) as number[];
        const medianLix = utils.getMedian(lixValues) as number;
        const meanLix = utils.getMean(lixValues) as number;

        // Calculate and find LIX
        const generatedLix = calculateLixFromStats(totalStats) as number;
        const foundLix = await searchForLixInItems(spineItems) as number | null;

        const file_bytes = (await zip.generateAsync({type: 'nodebuffer'})).byteLength as number;

        // 
        const analysis = {
            file_bytes,
            lix: foundLix ?? generatedLix,
            stats: {
                found_lix: foundLix,
                generated_lix: generatedLix,
                word_count: totalStats.word_count,
                long_word_count: totalStats.long_word_count,
                sentence_count: totalStats.sentence_count },
            items: spineItemStats,
        } as Analysis;

        // Stats
            console.log();
            console.log(`| Words:         ${analysis.stats.word_count}`);
            console.log(`| Long words:    ${analysis.stats.long_word_count}`);
            console.log(`| Sentences:     ${analysis.stats.sentence_count}`);
            console.log();
            console.log(`| LIX found:     ${analysis.stats.found_lix}`);
            console.log(`| LIX generated: ${analysis.stats.generated_lix}`);
            console.log();
            console.log(`| LIX median:    ${medianLix}`);
            console.log(`| LIX mean:      ${meanLix.toFixed()}`);

        return analysis;

    } catch (error) {
        const message = (`Failed to analyze EPUB file at path ${filePath}: ${error}`);
        console.error(message);
        throw Error(message);
    }
}

/**
 * Loads an EPUB file from and returns a loaded JSZip object.
 * @param filePath The path to the EPUB file to load.
 * @returns The loaded JSZip object.
 * @throws An error if the file is not a valid EPUB file.
 */
async function loadZip(filePath: string): Promise<JSZip> {
    // Load the file into memory as a buffer and parse it as a zip object
    //    The EPUB file format is XML metadata with XHTML content, inside a zip container. 
    const buffer = await fs.promises.readFile(filePath) as Buffer;
    const zip = await JSZip.loadAsync(buffer) as JSZip;

    // Validate file type is 'application/epub+zip'
    const mimetype = await zip.file('mimetype')!.async('string') as string;
    if (!mimetype || mimetype !== 'application/epub+zip') throw Error(`Invalid file type. Expected 'application/epub+zip', got '${mimetype}'.`);

    return zip;
}

/**
 * Finds the path to the OPF file in an EPUB.
 * @param zip The contents of the EPUB file.
 * @returns The path to the OPF file.
 */
async function findOpfPath(zip: JSZip): Promise<string> {
    // Load metadata file 'container.xml' and parse it as JSON
    //    'container.xml' is a XML document that indicates where to find the content of the EPUB
    const containerXml = await zip.file('META-INF/container.xml')!.async('string') as string;

    if (!containerXml) throw Error(`Invalid EPUB format. Could not find 'container.xml' file.`);

    const containerJson = await xml2js.parseStringPromise(containerXml) as any;

    // Get path of the OPF file (the main metadata file)
    const opfPath = containerJson.container.rootfiles[0].rootfile[0].$['full-path'] as string;
    return opfPath;
}

/**
 * Loads the OPF file as JSON.
 * @param opfPath The path to the OPF file.
 * @param zip The contents of the EPUB file.
 * @returns The OPF file as JSON.
 */
async function loadOpfJson(opfPath: string, zip: JSZip): Promise<any> {
    // Load OPF content file and parse it as JSON
    //    The .opf content file contains a complete manifest of the EPUB contents,
    //    including an ordered table of contents with references to each chapter or section of the EPUB.
    const opfXml = await zip.file(opfPath)!.async('string') as string;
    
    if (!opfXml) throw Error(`Invalid EPUB format. Could not find OPF file at path: ${opfPath}`);

    const opfJson = await xml2js.parseStringPromise(opfXml) as any;
    return opfJson;
}

/**
 * Extracts an array of the paths of all HTML files included in the EPUB manifest.
 * @param opfJson The JSON object representing the OPF file of the parsed EPUB file.
 * @param opfRoot The base directory of the EPUB's content file.
 * @returns An array of HTML file paths from the EPUB manifest.
 */
function extractItemPathsFromManifest(opfJson: any, opfRoot: string): string[] {
    // Get the manifest from the content object
    const manifest = opfJson.package.manifest[0].item as any;

    // Loop over the manifest items and collect items with HTML paths
    const htmlItemPaths = manifest
        .filter((item: any) => item.$['media-type'] === 'application/xhtml+xml')
        .map((item: any) => { 
            return opfRoot.length > 1 ?
                `${opfRoot}/${item.$.href}` :
                `${item.$.href}`
        }) as string[];

    if (!htmlItemPaths) throw Error('Invalid EPUB format. Could not find any HTML content in manifest.');

    return htmlItemPaths;
}

/**
 * Extracts text content from HTML files inside a zip archive.
 * @param spineItemPaths An array of paths to the HTML files located in the spine.
 * @param zip A JSZip instance containing the HTML files.
 * @returns A Promise that resolves to an array of SpineItem objects with path and content of HTML file.
 */
async function extractItemsFromSpine(spineItemPaths: string[], zip: JSZip): Promise<SpineItem[]> {
    // Create an array to store promises for each item's content retrieval
    const promises = spineItemPaths.map(async (spineItemPath) => {
        try {
            // Load as string the HTML file content located at the path
            const htmlContent = await zip.file(spineItemPath)?.async('string') || '';

            if (!htmlContent) throw Error(`HTML item not found: ${spineItemPath}`);

            // Create a JSDOM document object and load HTML content to it
            const document = getHtmlDocument(htmlContent, spineItemPath);

            // Remove all <sup> and <nav> tags from the document
            document.querySelectorAll('sup, nav').forEach(tag => tag.remove());
            document.querySelectorAll('br').forEach(tag => tag.replaceWith(' '));

        // TODO: IF NO CONTENT IN DOCUMENT FOUND, CHECK IF IMAGE WITH TEXT
        // TODO: <SPAN> TAGS WITHIN <P> TAGS, ENSURE CORRECT FORMATTING (INSERT SPACES AND NEWLINES WHERE MISSING)

            // Extract text content from paragraphs <p> or the entire body element
            const paragraphs = Array.from(document.querySelectorAll('p'))
                .filter(text => text.textContent?.trim().length !== 0);

            const text = paragraphs.length > 0 ?
                paragraphs : Array.from(document.querySelectorAll('body'))
                    .filter(text => text.textContent?.trim().length !== 0);

            // Clean up text content and expand abbreviations
            const prettyTextPromises = text.map(async text => {
                const formattedText = cleanUpFormatting(text.textContent!)
                const cleanedUpText = await expandAbbreviations(formattedText);
                return cleanedUpText;
            });

            // Combine paragraphs or body content into a single string
            const spineItemTextContent = (await Promise.all(prettyTextPromises)).join(' ').trim();

            // Return the current HTML item's name and content
            const spineItem: SpineItem = {
                path: spineItemPath,
                text_content: spineItemTextContent,
            }
            return spineItem;

        } catch (error) {
            // If there was an error processing the HTML file, return a TextItem object with an empty content string
                console.error(`${spineItemPath}`, error);
            return {
                path: spineItemPath,
                text_content: '',
            };
        }
    }) as Promise<SpineItem>[];

    // Wait for all promises to resolve and filter out any null results
    const results = (await Promise.all(promises)).filter(result => result.text_content) as SpineItem[];

    if (!results.length) throw Error('Invalid EPUB format. Could not find any HTML content in spine.');

    return results;
}

async function getSpineItemStats(items: SpineItem[]): Promise<SpineItemStats[]> {
    const chapterRegex = /chapter|kapitel/i;

    // TODO: FEW LIX CANDIDATES, DO SOMETHING ELSE

    const chapters = items.filter(item => chapterRegex.test(item.path)) as SpineItem[];;

    // If EPUB has explicit chapter(s), limit calculation to chapter(s),
    // otherwise expand calculation to entire contents
    const contentItems = chapters.length > 0 ? chapters : items as SpineItem[];
    const contentType = chapters.length > 0 ? 'chapter' : 'item' as string;

        console.log(`[${getSpineItemStats.name}] Calculating LIX for ${contentItems.length} ${contentType}(s).\n`);

    // Use Promise.all to process all items asynchronously
    const spineItemContentPromises = contentItems.map(async item => {

        // Calculate stats (amount of words, long words and sentences) for the item
        const itemContent: Content = getContentFromText(item.text_content);

        const itemStats: ContentStats = {
            word_count: itemContent.words.length,
            long_word_count: itemContent.long_words.length,
            sentence_count: itemContent.sentences.length }

        const generated_lix: number = calculateLixFromStats(itemStats);

        const spineItemContent: SpineItemContent = {
            name: path.basename(item.path),
            generated_lix: generated_lix,
            ...itemContent,
        };
        return spineItemContent;
    }) as Promise<SpineItemContent>[];

    const spineItemContentArr = (await Promise.all(spineItemContentPromises))
        .filter(item => item.generated_lix) as SpineItemContent[];

    const spineItemsFiltered = filterItemsUsingStandardDeviation(spineItemContentArr, 6) as SpineItemContent[];

    // for (const item of spineItemsFiltered) {
    //     item.sentences.map(e => {
    //         console.log(e);
    //     })
    // }

    // Get stats from content and sort items based on name
    const spineItemStats = spineItemsFiltered
        .map(item => {
            return {
                name:             item.name,
                generated_lix:    item.generated_lix,
                word_count:       item.words.length,
                long_word_count:  item.long_words.length,
                sentence_count:   item.sentences.length,
        }})
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base'})) as SpineItemStats[];

    return spineItemStats;
}

async function searchForLixInItems(items: SpineItem[]): Promise<number | null> {
    // Define regular expressions for finding the colophon
    const colophonRegex = /colophon|kolofon/i;

    // Attempt to find colophon in items
    const colophon = items.find(item => colophonRegex.test(item.path)) as SpineItem | undefined;

    // If EPUB has colophon, limit LIX search to colophon of EPUB
    if (colophon) {
        process.stdout.write(`\n[${searchForLixInItems.name}] Searching for LIX in colophon`);
        const result = searchForLixInText(colophon.text_content);
        if (result) {
            process.stdout.write(': FOUND\n');
            return result;
        }
        process.stdout.write(': NOT FOUND\n');
    }

    // If no colophon OR no LIX found in colophon, expand search to entire contents
    process.stdout.write(`[${searchForLixInItems.name}] Searching for LIX in ${items.length} items`);
    for (const item of items) {
        const result = searchForLixInText(item.text_content) as number | null;
        if (result) {
            process.stdout.write(': FOUND\n');
            return result;
        }
    }
    process.stdout.write(': NOT FOUND\n');
    return null;
}

/**
 * Calculates statistics from a paragraph of text.
 * @param text The text content to calculate stats for.
 * @returns A Content object containing the calculated word/sentence from the text.
 */
export function getContentFromText(text: string): Content {

    const exceptions = ['pc', 'wc'] as string[];
    const consonants = /bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]/; // TODO: fix acronyms with capital letters

    // Regular expression to split text into sentences
    const sentenceRegex = new RegExp(
        `(?<!\\s(?!${exceptions.join('|')})[${consonants}]{1,3}\\.)` + // negative lookbehind to ignore certain consonant abbrev. (e.g. "Mr.")
        `(?<=[.!?'"])` +                // lookbehind assert a sentence-ending punctuation mark
        '\\s+' +                        // match on whitespace
        '(?=[^a-zà-ÿ.(])',              // lookahead assert a non-lowercase, non-period character
        'g'                             // global: match all instances in the text
    );

    // Regular expression to match all words in text
    const wordRegex = new RegExp(
        `[a-zA-ZÀ-ÿ0-9]+` +             // matches one or more letters, numbers or accented characters (e.g. À, ÿ)
        `(?:[.'][a-zA-ZÀ-ÿ]+)*`,        // matches zero or more occurrences of a . or ' followed by one or more letters (e.g. "O'Reilly" or "U.S.")
        `g`                             // global: match all words in the text
    );

    // Split the text into sentences
    const sentences = text
        .trim()
        .split(sentenceRegex)
        .filter(s => s.trim().length > 0);

    // Find all words text
    const words = text
        .match(wordRegex)!
        .filter(word => word?.length > 0);

    // Create an array of long words (words longer than 6 characters)
    const long_words = words
        .filter(word => word.length > 6);

    // Create a Content object with the collected data
    const textContent = {
        words,
        long_words,
        sentences,
    } as Content;
    return textContent;
}

/**
 * Searches for the LIX readability index in a piece of text.
 * @param text The text to search.
 * @returns The found LIX value in the text, or null if no LIX value was found.
 */
export function searchForLixInText(text: string): number | null {

  // Regular expression to match LIX values in text
    const lixRegex = new RegExp(
        `(?<![A-ZÀ-ÿ])`+        // negative lookbehind assert no characters immediately before
        `LIX`+                  // match on case-insensitive 'LIX'
        `\\s*`+                 // optionally match whitespace(s)
        `\\-?`+                 // optionally match a hypen
        `(?:TAL)?`+             // optionally match case-insensitive 'TAL'
        `\\:?`+                 // optionally match a colon
        `\\s*`+                 // optionally match whitespace(s)
        `(\\d{1,2})`+           // catch one or more digits
        `(?!\\d?[\\-\\+])`,     // negative lookahead assert no '-' or '+' after digit(s)
        `gim`                   // global, case-insensitive, multiple lines
    );

    try {
        // Search for LIX in the text and return it if found - else return null
        const result = lixRegex.exec(text) as RegExpExecArray | null;
        return result === null ? null : parseInt(result[1]);
    } catch (error) {
        console.error(`Error searching for LIX: ${error}`);
        return null;
    }
    // TODO: Better handling of multiple LIX found in text.


    // const matches = Array.from(text.matchAll(lixRegex));
    // if (matches.length == 0) {
    //     return null;
    // }

    // matches.forEach(element => {

    //     const before = text.substring(element.index! - 10, element.index!)
    //     const after = text.substring(element.index! + element[0].length, element.index! + element[0].length + 10)

    //     console.log(before + element[0] + after)
    //     //console.log(element[0])
    //     //console.log(matches.length)
    //     //console.log(element[1]);
    // });

    // for (let i = 1; i < matches.length; i++) {
    //     let j = matches[i - 1];
    //     let k = matches[i];

    //     const jBefore = text.substring(j.index! - 1, j.index!);
    //     const kBefore = text.substring(k.index! - 1, k.index!);

    //     if (jBefore == kBefore) {
    //         console.log(j + ' == ' + k);
    //     } else {
    //         console.log(j + ' != ' + k);
    //     }
    // }
}

/**
 * Calculates the LIX readability index of a piece of text in the TextData format.
 * @param stats The stats to calculate the LIX value of.
 * @returns The calculated LIX value of the TextData object.
 */
function calculateLixFromStats(stats: ContentStats): number {
    try {
        const word_count      = stats.word_count;
        const long_word_count = stats.long_word_count;
        const sentence_count  = stats.sentence_count;

        const sentenceLength  = (word_count / sentence_count);
        const longWordRatio   = ((long_word_count * 100) / word_count);

        const lix = (sentenceLength + longWordRatio);
        return Number(lix.toFixed());
    } catch (error) {
        throw Error (`Error calculating LIX: ${error}`)
    }
}

/**
 * Removes the items from the array that have LIX index values outside the standard deviation range.
 * @param items The array of items to filter.
 * @param stdDevCap The standard deviation cap, i.e. the upper limit the LIX standard deviation has to exceed,
 * for item filtering to be enabled.
 * @returns Array of filtered items.
 */
function filterItemsUsingStandardDeviation(array: SpineItemContent[], stdDevCap: number): SpineItemContent[] {
    const sortedArr = array.slice().sort((a, b) => a.generated_lix - b.generated_lix);
    const midIndex = Math.floor(sortedArr.length / 2);
    const midValue = sortedArr[midIndex].generated_lix;

    const stdDev = utils.getStandardDeviation(
        sortedArr.map(item => Number(item.generated_lix.toFixed())));

    const upperBound = Number((midValue + stdDev).toPrecision());
    const lowerBound = Number((midValue - stdDev).toPrecision());

    try {
        if (stdDev > stdDevCap) {
            for (let i = 0; i < sortedArr.length; i++) {

                const lixValue = Number(sortedArr[i].generated_lix.toPrecision(4));

                if (sortedArr[i].generated_lix > upperBound) {
                    console.log(` - removed LIX value '${lixValue}' - higher than '${upperBound.toPrecision(4)}' (median ${midValue.toPrecision(4)} + stnd. dev. ${stdDev.toPrecision(4)})`);
                    sortedArr.splice(i, 1);
                    i--;
                }

                if (sortedArr[i].generated_lix < lowerBound) {
                    console.log(` - removed LIX value '${lixValue}' - lower than '${lowerBound.toPrecision(4)}' (median ${midValue.toPrecision(4)} - stnd. dev. ${stdDev.toPrecision(4)})`);
                    sortedArr.splice(i, 1);
                    i--;
                }
            }
        }
        return sortedArr;
    } catch (error) {
        console.error(`Error filtering items using standard deviation: ${error}`);
        return sortedArr;
    }
}

/**
 * Converts the HTML content into a DOM tree and returns the document object.
 * @param htmlContent The HTML content to parse.
 * @param htmlItemPath The path of the HTML file.
 * @returns A document object representing the parsed HTML content.
 */
function getHtmlDocument(htmlContent: string, htmlItemPath: string) {
    try {
        // Attempt to parse the HTML content as 'application/xhtml+xml'
        const doc = new JSDOM(htmlContent, { contentType: 'application/xhtml+xml' }).window.document as Document;
        return doc;

    } catch (error) {
        console.warn(`[${getHtmlDocument.name}] Error loading '${path.basename(htmlItemPath)}' as 'application/xhtml+xml' content: ${error}`);
        try {
            // If parsing as 'application/xhtml+xml' fails, attempt to parse as 'text/html'
            process.stdout.write(`[${getHtmlDocument.name}] Attempting to load '${path.basename(htmlItemPath)}' as 'text/html content'`);
            
            const doc = new JSDOM(htmlContent, { contentType: 'text/html' }).window.document as Document;
            process.stdout.write(`: SUCCESS.\n`);
            return doc;

        } catch (error) {
            // If parsing as 'text/html' also fails, return an empty document object
            process.stdout.write(`: FAILED.\n`);
            throw Error(`[${getHtmlDocument.name}] Error loading '${path.basename(htmlItemPath)}' as 'text/html content': ${error}`);
        }
    }
}

/**
 * Removes unnecessary characters and formatting from the input text.
 * @param text The input text to be cleaned.
 * @returns The cleaned text without unnecessary characters and formatting.
 */
function cleanUpFormatting(text: string): string {
    try {
        const emojiRegex = /(?<=\s)\:\'\(/g;

        const cleanText = text.trim()
            .replace(/\n/g, ` `)    // Find newlines
            .replace(/[\u2018\u2019]/g, `'`)    // Find apostrophes
            .replace(/[«»„”“]/g, `"`)    // Find 'special' quotation marks
            .replace(/[\u00AD\u2013]\s?/g, ``)    // Find special Unicode characters ('soft hyphen', 'en dash')
            .replace(emojiRegex, '')
            .replace(/\s{2,}/g, ` `);   // Find two or more white spaces in succession
        return cleanText;
    } catch (error) {
        console.error(`Error cleaning up text: ${error}`);
        return text;
    }
}

/**
 * Replaces abbreviations in a given text with their full term, based on the abbreviations from './abbreviations'.
 * @param text The text to clean up.
 * @returns The cleaned up text with replaced abbreviations.
 */
async function expandAbbreviations(text: string): Promise<string> {
    try {
        const abbreviationsList: AbbreviationMap = await ABBREVIATIONS_LIST;
        const abbreviationsKeys = Object.keys(abbreviationsList).join('|').replace(/\./g, '\\.');
        const abbreviationRegex = new RegExp(
            `(?<=[\\s\\(])` +           // lookbehind assert abbreviation preceded by
            `(${abbreviationsKeys})` +  // match
            `(?=[\\s$,.!?)])`,          // lookahead assert abbreviation followed by
            `g`
        );

        // Replace the abbreviation with the full term
        const cleanedText = text.replace(abbreviationRegex, key => abbreviationsList[key]);

        // Return the cleaned up text with replaced abbreviations.
        return cleanedText;

    } catch (error) {
        console.error(`Error expanding abbreviations: ${error}`);
        return text;
    }
}

function getTotalStats(items: SpineItemStats[]): ContentStats {
    try {
        return items.reduce(
            (prev, curr) => ({
                word_count: (prev.word_count) + (curr.word_count),
                long_word_count: (prev.long_word_count) + (curr.long_word_count),
                sentence_count: (prev.sentence_count) + (curr.sentence_count),
            }),
            { word_count: 0, long_word_count: 0, sentence_count: 0 }
        ) as ContentStats;
    } catch (error) {
        throw Error(`[${getTotalStats.name}] Could not calculate total stats: ${error}`);
    }
}