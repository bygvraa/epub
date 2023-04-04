import * as fs from 'fs'
import * as path from 'path'
import * as xml2js from 'xml2js'
import JSZip = require('jszip')
import { JSDOM } from 'jsdom'
import * as utils from './utils'
import {
  AbbreviationMap,
  Analysis,
  SpineItem,
  SpineItemContent,
  SpineItemStats,
  TextContent,
  TextContentStats,
} from './@types/Analysis'
import { logger } from 'firebase-functions'

// Load abbreviations file and export it as a constant
//const ABBREVIATIONS_LIST = JSON.parse(fs.readFileSync(`${__dirname}/abbreviations.json`).toString())
//import ABBREVIATIONS_LIST from './abbreviations.json';

const ABBREVIATIONS_LIST = {
  'f.eks.': 'for eksempel',
  ['fx']: 'for eksempel',
  'bl.a.': 'blandt andet',
  'Bl.a.': 'Blandt andet',
  'm.fl.': 'med flere',
  'o.a.': 'og andre',
  's.': 'side',
  'o.s.v.': 'og så videre',
  'm.m.': 'med mere',
  'vol.': 'volumen',
}

/**
 * Analyzes an EPUB file and returns statistics about its contents.
 * @param filePath The path to the EPUB file to analyze.
 * @throws An error if the provided file path is invalid or the file is not a valid EPUB.
 * @returns {Promise<Analysis>}
 */
export async function analyzeEpub(filePath: string): Promise<Analysis> {
  try {
    // Load epub as zip
    //    The EPUB file format is XML metadata with XHTML content, inside a zip container.
    const zip: typeof JSZip = await loadZip(filePath)

    // Find .opf content path
    const opfPath: string = await findOpfPath(zip)

    // Load .opf content file and parse it as JSON
    //    The .opf content file contains a complete manifest of the EPUB contents,
    //    including an ordered table of contents with references to each chapter or section of the EPUB.
    const opfJson = await loadOpfJson(opfPath, zip)

    // Get root path of the .opf content file
    const opfRoot: string = path.dirname(opfPath)

    // Get paths of HTML content from EPUB file manifest
    //    The manifest contains a an unsorted list of every item in the EPUB
    const spineItemPaths: string[] = extractItemPathsFromManifest(opfJson, opfRoot)

    // Get HTML content from EPUB file spine
    //    The spine lists all XHTML content documents in a specific reading order
    const spineItems: SpineItem[] = await extractItemsFromSpine(spineItemPaths, zip)

    // Get stats from content
    const spineItemStats: SpineItemStats[] = await getSpineItemStats(spineItems)

    // Sum total amount of words, long words, and sentences
    const totalStats: TextContentStats = getTotalStats(spineItemStats)

    // Calculate median and mean LIX values
    const lixValues: number[] = spineItemStats.map((item) => item.generated_lix)
    const lixMedian: number = utils.getMedian(lixValues)
    const lixMean: number = utils.getMean(lixValues)

    // Calculate and find LIX
    const lixGenerated: number = calculateLixFromStats(totalStats)
    const lixFound: number | null = await searchForLixInItems(spineItems)

    const file_bytes: number = (await zip.generateAsync({ type: 'nodebuffer' })).byteLength

    const analysis: Analysis = {
      file_bytes,
      lix: lixFound ?? lixMedian ?? lixGenerated,
      stats: {
        lix_found: lixFound,
        lix_median: lixMedian,
        lix_generated: lixGenerated,
        word_count: totalStats.word_count,
        long_word_count: totalStats.long_word_count,
        sentence_count: totalStats.sentence_count,
      },
      items: spineItemStats,
    }
    logger.info
    // Stats
    console.log(`| Words:         ${analysis.stats?.word_count}`)
    console.log(`| Long words:    ${analysis.stats?.long_word_count}`)
    console.log(`| Sentences:     ${analysis.stats?.sentence_count}`)
    console.log(`| LIX found:     ${analysis.stats?.lix_found}`)
    console.log(`| LIX generated: ${analysis.stats?.lix_generated}`)
    console.log(`| LIX median:    ${analysis.stats?.lix_median}`)
    console.log(`| LIX mean:      ${lixMean.toFixed()}`)

    return analysis
  } catch (error) {
    const message = `Failed to analyze EPUB file: ${error}`
    console.error(message)
    throw Error(message)
  }
}

/**
 * Loads EPUB file and returns a loaded JSZip object.
 * @param filePath The path to the EPUB file to load.
 * @returns The loaded EPUB as a JSZip object.
 */
async function loadZip(filePath: string): Promise<typeof JSZip> {
  try {
    // Load the file into memory as a buffer and parse it as a zip object
    const buffer: Buffer = await fs.promises.readFile(filePath)
    const zip: JSZip = await JSZip.loadAsync(buffer)

    // Validate file type is 'application/epub+zip'
    const mimetype: string = (await zip.file('mimetype')?.async('string')) || ''

    if (!mimetype || mimetype !== 'application/epub+zip') {
      throw Error(
        `[${loadZip.name}] Invalid file type. Expected 'application/epub+zip', got '${mimetype}'.`
      )
    }

    return zip
  } catch (error) {
    throw Error(`[${loadZip.name}] Unable to load EPUB as zip: ${error}`)
  }
}

/**
 * Finds path to the OPF file in an EPUB.
 * @param zip The contents of the EPUB file.
 * @returns The path to the OPF file.
 */
async function findOpfPath(zip: typeof JSZip): Promise<string> {
  try {
    // Load metadata file 'container.xml' and parse it as JSON
    //    'container.xml' is a XML document that indicates where to find the content of the EPUB
    const containerXml: string = (await zip.file('META-INF/container.xml')?.async('string')) || ''
    if (!containerXml) {
      throw Error(`[${findOpfPath.name}] Invalid EPUB format. Could not find 'container.xml' file.`)
    }

    const containerJson = await xml2js.parseStringPromise(containerXml)

    // Get path of the OPF file (the main metadata file)
    const opfPath: string = containerJson.container.rootfiles[0].rootfile[0].$['full-path']
    return opfPath
  } catch (error) {
    throw Error(`[${findOpfPath.name}] Unable to find .opf file path: ${error}`)
  }
}

/**
 * Loads the OPF file as JSON.
 * @param opfPath The path to the OPF file.
 * @param zip The contents of the EPUB file.
 * @returns The OPF file as JSON.
 */
async function loadOpfJson(opfPath: string, zip: typeof JSZip): Promise<any> {
  try {
    // Load OPF content file and parse it as JSON
    const opfXml: string = (await zip.file(opfPath)?.async('string')) || ''
    if (!opfXml) {
      throw Error(
        `[${loadOpfJson.name}] Invalid EPUB format. Could not find OPF file at path: ${opfPath}`
      )
    }
    const opfJson = await xml2js.parseStringPromise(opfXml)
    return opfJson
  } catch (error) {
    throw Error(`[${loadOpfJson.name}] Unable to load .opf content file: ${error}`)
  }
}

/**
 * Extracts an array of the paths of all HTML files included in the EPUB manifest.
 * @param opfJson The JSON object representing the OPF file of the parsed EPUB file.
 * @param opfRoot The base directory of the EPUB's content file.
 * @returns An array of HTML file paths from the EPUB manifest.
 */
function extractItemPathsFromManifest(opfJson: any, opfRoot: string): string[] {
  try {
    // Get manifest from OPF JSON object
    const manifest = opfJson.package.manifest[0].item

    // Loop over the manifest items and collect items with HTML paths
    const htmlItemPaths: string[] = manifest
      .filter((item: any) => item.$['media-type'] === 'application/xhtml+xml')
      .map((item: any) => {
        return opfRoot.length > 1 ? `${opfRoot}/${item.$.href}` : `${item.$.href}`
      })

    if (!htmlItemPaths) {
      throw Error(
        `[${extractItemPathsFromManifest.name}] Invalid EPUB format. Could not find any HTML content in manifest`
      )
    }

    return htmlItemPaths
  } catch (error) {
    throw Error(
      `[${extractItemPathsFromManifest.name}] Unable to extract item paths from manifest: ${error}`
    )
  }
}

/**
 * Extracts text content from HTML files inside a zip archive.
 * @param spineItemPaths An array of paths to the HTML files located in the spine.
 * @param zip A JSZip instance containing the HTML files.
 * @returns A Promise that resolves to an array of SpineItem objects with path and content of HTML file.
 */
async function extractItemsFromSpine(
  spineItemPaths: string[],
  zip: typeof JSZip
): Promise<SpineItem[]> {
  // Create an array to store promises for each item's content retrieval
  const promises: Promise<SpineItem>[] = spineItemPaths.map(async (spineItemPath) => {
    try {
      // Load as string the HTML file content located at the path
      const htmlContent = (await zip.file(spineItemPath)?.async('string')) || ''

      if (!htmlContent) {
        throw Error(`[${extractItemsFromSpine.name}] HTML item not found: ${spineItemPath}`)
      }

      // Create a JSDOM document object and load HTML content to it
      const document = getHtmlDocument(htmlContent, spineItemPath)

      // Remove all <sup> and <nav> tags from the document
      document.querySelectorAll('sup, nav').forEach((tag) => tag.remove())
      document.querySelectorAll('br').forEach((tag) => tag.replaceWith(' '))

      // TODO: IF NO CONTENT IN DOCUMENT FOUND, CHECK IF IMAGE WITH TEXT
      // TODO: <SPAN> TAGS WITHIN <P> TAGS, ENSURE CORRECT FORMATTING (INSERT SPACES AND NEWLINES WHERE MISSING)

      // Extract text content from paragraphs <p> or the entire body element
      const paragraphs = Array.from(document.querySelectorAll('p')).filter(
        (text) => text.textContent?.trim().length !== 0
      )

      const rawTest =
        paragraphs.length > 0
          ? paragraphs
          : Array.from(document.querySelectorAll('body')).filter(
              (text) => text.textContent?.trim().length !== 0
            )

      // Clean up text content and expand abbreviations
      const prettyTextPromises = rawTest.map(async (text) => {
        if (spineItemPath.includes('chapter')) {
            //console.log(htmlContent);
        }
        const formattedText = cleanUpFormatting(text.textContent || '')
        const cleanedUpText = await expandAbbreviations(formattedText)
        return cleanedUpText
      })

      // Combine paragraphs or body content into a single string
      const spineItemTextContent = (await Promise.all(prettyTextPromises)).join(' ').trim()

      // Return the current HTML item's name and content
      const spineItem: SpineItem = {
        path: spineItemPath,
        text: spineItemTextContent,
      }
      return spineItem
    } catch (error) {
      // If there was an error processing the HTML file, return a TextItem object with an empty content string
      console.error(`${spineItemPath}`, error)
      return <SpineItem>{
        path: spineItemPath,
        text: '',
      }
    }
  })

  // Wait for all promises to resolve and filter out any null results
  const spineItems: SpineItem[] = (await Promise.all(promises)).filter((item) => item.text)

  if (!spineItems.length) {
    throw Error(
      `[${extractItemsFromSpine.name}] Invalid EPUB format. Could not find any HTML content in spine`
    )
  }
  return spineItems
}

/**
 * Calculate LIX readability scores for a collection of spine items in an EPUB.
 * @param spineItems Array of spine items to process.
 * @returns Promise containing an array of SpineItemStats.
 */
async function getSpineItemStats(spineItems: SpineItem[]): Promise<SpineItemStats[]> {
  // Define regular expression for finding chapter(s)
  const CHAPTER_REGEX = /chapter|kapitel/i
  const STANDARD_DEVIATION_FACTOR = 6

  // TODO: IF FEW LIX CANDIDATES, DO SOMETHING ELSE

  try {
    // Attempt to find chapter(s) in spine items, if any
    const chapters: SpineItem[] = spineItems.filter((item) => CHAPTER_REGEX.test(item.path))

    // If EPUB has explicit chapter(s), limit calculation to chapter(s),
    // otherwise expand calculation to entire contents
    const contentItems: SpineItem[] = chapters.length > 0 ? chapters : spineItems
    const contentType: string = chapters.length > 0 ? 'chapter' : 'item'

    console.log(
      `[${getSpineItemStats.name}] Calculating LIX for ${contentItems.length} ${contentType}(s)`
    )

    // Use Promise.all to process all items asynchronously
    const spineItemContentPromises: Promise<SpineItemContent>[] = contentItems.map(async (item) => {
      // Extraxt text content (amount of words, long words and sentences) from the item
      const { words, long_words, sentences }: TextContent = extractContentFromText(item.text)

      const generated_lix: number = calculateLixFromStats({
        word_count: words.length,
        long_word_count: long_words.length,
        sentence_count: sentences.length,
      })

      const spineItemContent: SpineItemContent = {
        title: path.basename(item.path),
        generated_lix,
        words,
        long_words,
        sentences,
      }

      return spineItemContent
    })

    const spineItemContent: SpineItemContent[] = await Promise.all(spineItemContentPromises)
    const filteredSpineItemContent: SpineItemContent[] = spineItemContent.filter(
      (item) => item.generated_lix
    )

    const filteredSpineItems: SpineItemContent[] = filterItemsUsingStandardDeviation(
      filteredSpineItemContent,
      STANDARD_DEVIATION_FACTOR
    )

    // Get stats from content and sort items based on name
    const spineItemStats: SpineItemStats[] = filteredSpineItems
      .map((item) => ({
        title: item.title,
        generated_lix: item.generated_lix,
        word_count: item.words.length,
        long_word_count: item.long_words.length,
        sentence_count: item.sentences.length,
      }))
      .sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
      )
    return spineItemStats
  } catch (error) {
    throw Error(`[${getSpineItemStats.name}] Unable to get spine item stats: ${error}`)
  }
}

async function searchForLixInItems(items: SpineItem[]): Promise<number | null> {
  // Define regular expression for finding the colophon
  const COLOPHON_REGEX = /colophon|kolofon/i

  try {
    // Attempt to find colophon in items
    const colophon: SpineItem | undefined = items.find((item) => COLOPHON_REGEX.test(item.path))

    // If EPUB has colophon, limit LIX search to colophon of EPUB
    if (colophon) {
      process.stdout.write(`[${searchForLixInItems.name}] Searching for LIX in colophon`)
      const result = searchForLixInText(colophon.text)
      if (result) {
        process.stdout.write(': FOUND\n')
        return result
      }
      process.stdout.write(': NOT FOUND\n')
    }

    // If no colophon OR no LIX found in colophon, expand search to entire contents
    process.stdout.write(`[${searchForLixInItems.name}] Searching for LIX in ${items.length} items`)
    for (const item of items) {
      const result: number | null = searchForLixInText(item.text)
      if (result) {
        process.stdout.write(': FOUND\n')
        return result
      }
    }
    process.stdout.write(': NOT FOUND\n')
    return null
  } catch (error) {
    throw Error(`[${searchForLixInText.name}] Error searching for LIX in items: ${error}`)
  }
}

/**
 * Extracts content (words, long words, and sentences) from a piece of text.
 * @param text The text content to calculate stats for.
 * @returns A TextContent object containing the extracted words/sentences from the text.
 */
export function extractContentFromText(text: string): TextContent {
  const EXCEPTIONS: string[] = ['pc', 'wc']
  const CONSONTANTS = /bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]/ // TODO: fix acronyms with capital letters

  // Regular expression to split text into sentences
  const SENTENCE_REGEX = new RegExp(
    `(?<!\\s(?!${EXCEPTIONS.join('|')})[${CONSONTANTS}]{1,3}\\.)` + // negative lookbehind to ignore certain consonant abbrev. (e.g. "Mr.")
      `(?<=[.!?'"])` + // lookbehind assert a sentence-ending punctuation mark
      '\\s+' + // match on whitespace
      '(?=[^a-zà-ÿ.(])', // lookahead assert a non-lowercase, non-period character
    'g' // global: match all instances in the text
  )

  // Regular expression to match all words in text
  const WORD_REGEX = new RegExp(
    `[a-zA-ZÀ-ÿ0-9]+` + // matches one or more letters, numbers or accented characters (e.g. À, ÿ)
      `(?:[.'][a-zA-ZÀ-ÿ]+)*`, // matches zero or more occurrences of a . or ' followed by one or more letters (e.g. "O'Reilly" or "U.S.")
    `g` // global: match all words in the text
  )

  try {
    // Split the text into sentences
    const sentences: string[] =
      text
        .trim()
        .split(SENTENCE_REGEX)
        .filter((s) => s.trim().length > 0) || []

    // Find all words text
    const words: string[] = text.match(WORD_REGEX)?.filter((word) => word.length > 0) || []

    // Create an array of long words (words longer than 6 characters)
    const long_words: string[] = words.filter((word) => word.length > 6) || []

    // Create a TextContent object with the collected data
    const textContent: TextContent = {
      words,
      long_words,
      sentences,
    }
    return textContent
  } catch (error) {
    throw Error(`[${extractContentFromText.name}] Unable to extract content from text: ${error}`)
  }
}

/**
 * Searches for the LIX readability index in a piece of text.
 * @param text The text to search.
 * @returns The found LIX value in the text, or null if no LIX value was found.
 */
export function searchForLixInText(text: string): number | null {
  // Regular expression to match LIX values in text
  const LIX_REGEX = new RegExp(
    `(?<![A-ZÀ-ÿ])` + // negative lookbehind assert no characters immediately before
      `LIX` + // match on case-insensitive 'LIX'
      `\\s*` + // optionally match whitespace(s)
      `\\-?` + // optionally match a hypen
      `(?:TAL)?` + // optionally match case-insensitive 'TAL'
      `\\:?` + // optionally match a colon
      `\\s*` + // optionally match whitespace(s)
      `(\\d{1,2})` + // catch one or more digits
      `(?!\\d?[\\-\\+])`, // negative lookahead assert no '-' or '+' after digit(s)
    `gim` // global, case-insensitive, multiple lines
  )

  try {
    // Search for LIX in the text and return it if found - else return null
    const result: RegExpExecArray | null = LIX_REGEX.exec(text)
    return result === null ? null : parseInt(result[1])
  } catch (error) {
    console.error(`[${searchForLixInText.name}] Error searching for LIX in text: ${error}`)
    return null
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
function calculateLixFromStats(stats: TextContentStats): number {
  try {
    const word_count = stats.word_count
    const long_word_count = stats.long_word_count
    const sentence_count = stats.sentence_count

    const sentenceLength = word_count / sentence_count
    const longWordRatio = (long_word_count * 100) / word_count

    const lix = sentenceLength + longWordRatio
    return Number(lix.toFixed())
  } catch (error) {
    throw Error(`[${calculateLixFromStats.name}] Error calculating LIX: ${error}`)
  }
}

/**
 * Removes the items from the array that have LIX index values outside the standard deviation range.
 * @param items The array of spine item content to filter.
 * @param maxStdDev The max standard deviation, i.e. the upper limit the LIX standard deviation has to exceed,
 * for item filtering to be enabled.
 * @returns Array of filtered items.
 */
function filterItemsUsingStandardDeviation(
  items: SpineItemContent[],
  maxStdDev: number
): SpineItemContent[] {
  const sortedArr = items.slice().sort((a, b) => a.generated_lix - b.generated_lix)
  const midIndex = Math.floor(sortedArr.length / 2)
  const midValue = sortedArr[midIndex].generated_lix

  const stdDev = utils.getStandardDeviation(
    sortedArr.map((item) => Number(item.generated_lix.toFixed()))
  )

  const upperBound = Number((midValue + stdDev).toPrecision())
  const lowerBound = Number((midValue - stdDev).toPrecision())

  try {
    if (stdDev > maxStdDev) {
      for (let i = 0; i < sortedArr.length; i++) {
        const lixValue = Number(sortedArr[i].generated_lix.toPrecision(4))
        const lixTitle = sortedArr[i].title

        if (sortedArr[i].generated_lix > upperBound) {
          console.log(
            `[${
              filterItemsUsingStandardDeviation.name
            }] Removed LIX value '${lixValue}' from '${lixTitle}' - higher than '${upperBound.toPrecision(
              4
            )}' (median ${midValue.toPrecision(4)} + stnd. dev. ${stdDev.toPrecision(4)})`
          )
          sortedArr.splice(i, 1)
          i--
        }

        if (sortedArr[i].generated_lix < lowerBound) {
          console.log(
            `[${
              filterItemsUsingStandardDeviation.name
            }] Removed LIX value '${lixValue}' from '${lixTitle}' - lower than '${lowerBound.toPrecision(
              4
            )}' (median ${midValue.toPrecision(4)} - stnd. dev. ${stdDev.toPrecision(4)})`
          )
          sortedArr.splice(i, 1)
          i--
        }
      }
    }
    return sortedArr
  } catch (error) {
    console.error(
      `[${filterItemsUsingStandardDeviation.name}] Error filtering items using standard deviation: ${error}`
    )
    return sortedArr
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
    const doc: Document = new JSDOM(htmlContent, { contentType: 'application/xhtml+xml' }).window
      .document
    return doc
  } catch (error) {
    logger.warn(
      `[${getHtmlDocument.name}] Error loading '${path.basename(
        htmlItemPath
      )}' as 'application/xhtml+xml' content: ${error}`
    )
    try {
      // If parsing as 'application/xhtml+xml' fails, attempt to parse as 'text/html'
      process.stdout.write(
        `[${getHtmlDocument.name}] Attempting to load '${path.basename(
          htmlItemPath
        )}' as 'text/html content'`
      )

      const doc: Document = new JSDOM(htmlContent, { contentType: 'text/html' }).window.document
      process.stdout.write(`: SUCCESS.\n`)
      return doc
    } catch (err) {
      // If parsing as 'text/html' also fails, return an empty document object
      process.stdout.write(`: FAILED.\n`)
      throw Error(
        `[${getHtmlDocument.name}] Error loading '${path.basename(
          htmlItemPath
        )}' as 'text/html content': ${err}`
      )
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
    const emojiRegex = /(?<=\s):'\(/g

    const cleanText = text
      .trim()
      .replace(/\n/g, ` `) // Find newlines
      .replace(/[\u2018\u2019]/g, `'`) // Find apostrophes
      .replace(/[«»„”“]/g, `"`) // Find 'special' quotation marks
      .replace(/[\u00AD\u2013]\s?/g, ``) // Find special Unicode characters ('soft hyphen', 'en dash')
      .replace(emojiRegex, '')
      .replace(/\s{2,}/g, ` `) // Find two or more white spaces in succession
    return cleanText
  } catch (error) {
    console.error(`[${cleanUpFormatting.name}] Error cleaning up text: ${error}`)
    return text
  }
}

/**
 * Replaces abbreviations in a given text with their full term, based on the abbreviations from './abbreviations'.
 * @param text The text to clean up.
 * @returns The cleaned up text with replaced abbreviations.
 */
async function expandAbbreviations(text: string): Promise<string> {
  try {
    const abbreviationsList: AbbreviationMap = ABBREVIATIONS_LIST
    const abbreviationsKeys = Object.keys(abbreviationsList).join('|').replace(/\./g, '\\.')
    const abbreviationRegex = new RegExp(
      `(?<=[\\s\\(])` + // lookbehind assert abbreviation preceded by
        `(${abbreviationsKeys})` + // match
        `(?=[\\s$,.!?)])`, // lookahead assert abbreviation followed by
      `g`
    )

    // Replace the abbreviation with the full term
    const cleanedText = text.replace(abbreviationRegex, (key) => abbreviationsList[key])

    // Return the cleaned up text with replaced abbreviations.
    return cleanedText
  } catch (error) {
    console.error(`[${expandAbbreviations.name}] Error expanding abbreviations: ${error}`)
    return text
  }
}

function getTotalStats(items: SpineItemStats[]): TextContentStats {
  try {
    return <TextContentStats>items.reduce(
      (prev, curr) => ({
        word_count: prev.word_count + curr.word_count,
        long_word_count: prev.long_word_count + curr.long_word_count,
        sentence_count: prev.sentence_count + curr.sentence_count,
      }),
      { word_count: 0, long_word_count: 0, sentence_count: 0 }
    )
  } catch (error) {
    throw Error(`[${getTotalStats.name}] Could not calculate total stats: ${error}`)
  }
}
