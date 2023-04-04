import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import * as admin from 'firebase-admin'
import { Change, database, EventContext } from 'firebase-functions'
import { FieldValue } from 'firebase-admin/firestore'
import { analyzeEpub } from './analyzeEpub'
import { Analysis, MaterialUploadCompletionBySource, MaterialUploadCompletionData } from './@types/Analysis'

const storage = admin.storage()
const realtime = admin.database()
const firestore = admin.firestore()

/**
 * Cloud Function triggered when data is created, updated, or deleted on path in Realtime Database.
 * If material is created or updated, downloads material from Firebase Storage,
 * performs an analysis and uploads results to Firestore and Realtime Database.
 */
export async function handleAnalyzeEpubTrigger(
  change: Change<database.DataSnapshot>,
  context: EventContext
) {
  // Handle deletions elsewhere
  if (!change.after.exists()) {
    return
  }

  // Extract parameters and material data from context
  const { publisher_id, material_id, source } = context.params
  const { storage_bucket, storage_path, material_ext }: MaterialUploadCompletionData =
    change.after.val()

  // Handle audiobooks elsewhere
  if (material_ext !== 'epub') {
    return
  }

  if (!material_id) {
    throw Error('No material identifier found in metadata')
  }
  if (!publisher_id) {
    throw Error('No publisher identifier found in metadata')
  }

  try {
    // Download EPUB file from Firebase Storage to local temporary directory and get path
    const tempFilePath = await downloadEpubFromStorage(material_id, storage_bucket, storage_path)

    // Analyze the EPUB file and upload analysis
    const analysis: Analysis = await analyzeEpub(tempFilePath)
    await Promise.all([
      uploadEpubStatsToRealtime(publisher_id, material_id, source, analysis),
      uploadEpubStatsToFirestore(publisher_id, material_id, source, analysis),
    ])

    // Delete the downloaded file from the local temporary directory
    fs.unlink(
      tempFilePath,
      (error) =>
        error &&
        console.error(
          `[${handleAnalyzeEpubTrigger.name}] Failed to delete temporary file '${tempFilePath}': ${error}`
        )
    )

    console.log(
      `[${handleAnalyzeEpubTrigger.name}] Successfully analyzed material '${material_id}' from publisher '${publisher_id}'`
    )
  } catch (error) {
    const message: string = `[${handleAnalyzeEpubTrigger.name}] Failed to analyze material '${material_id}': ${error}`
    console.log(message)
    throw Error(message)
  }
}

/**
 * Cloud Function triggered when a material identifier is received from an HTTP API request,
 * retrieves metadata for material with the corresponding identifier, downloads the material from Firebase Storage,
 * performs an analysis and uploads results to Firestore and Realtime Database.
 * @param data - object containing material_id to be analyzed.
 */
export async function handleAnalyzeEpubAPI(data: { material_id: string }) {
  try {
    const { material_id } = data

    const MATERIAL_REGEX = /(?<![0-9])[0-9]{13}(?![0-9])/
    if (!material_id || !MATERIAL_REGEX.test(material_id)) {
      return 'Missing or invalid material identifier.'
    }

    const publisher_id = await getPublisherIdFromFirestore(material_id)
    const { source, material } = await getLatestMaterialFromRealtime(material_id, publisher_id)

    if (material.material_ext !== 'epub') {
      return `Cannot analyze material '${material_id}' because file type is '${material.material_ext}'`
    }

    // Download EPUB file from Firebase Storage to local temporary directory and get path
    const tempFilePath = await downloadEpubFromStorage(
      material_id,
      material.storage_bucket,
      material.storage_path
    )

    // Analyze the EPUB file and upload analysis
    const analysis: Analysis = await analyzeEpub(tempFilePath)
    await Promise.all([
      uploadEpubStatsToRealtime(publisher_id, material_id, source, analysis),
      uploadEpubStatsToFirestore(publisher_id, material_id, source, analysis),
    ])

    // Delete the downloaded file from the local temporary directory
    fs.unlink(
      tempFilePath,
      (error) =>
        error &&
        console.error(
          `[${handleAnalyzeEpubAPI.name}] Failed to delete temporary file '${tempFilePath}': ${error}`
        )
    )

    console.log(
      `[${handleAnalyzeEpubAPI.name}] Successfully analyzed material '${material_id}' from publisher '${publisher_id}'`
    )
    return analysis
  } catch (error) {
    const message: string = `[${handleAnalyzeEpubAPI.name}] Failed to analyze material '${data.material_id}': ${error}`
    console.log(message)
    throw Error(message)
  }
}

/**
 * Retrieves the publisher ID associated with a material from Firestore
 * @param material_id - The ISBN of the material
 * @returns Promise that resolves with the publisher ID
 */
async function getPublisherIdFromFirestore(material_id: string): Promise<string> {
  try {
    const material = await firestore
      .collection('application/application_data/publisher_isbns')
      .where('isbn', '==', material_id)
      .limit(1)
      .get()

    if (material.empty) {
      throw Error(`No material found with ID '${material_id}' in Firestore`)
    }

    const publisher_id = material.docs[0].get('publisher_id')
    return publisher_id
  } catch (error) {
    throw Error(
      `[${getPublisherIdFromFirestore.name}] Failed to retrieve publisher ID from Firestore for material '${material_id}': ${error}`
    )
  }
}

/**
 * Retrieves the latest material and its source from Realtime Database for a given material ID and publisher ID
 * @returns Promise that resolves with the metadata of the latest uploaded source
 */
async function getLatestMaterialFromRealtime(
  material_id: string,
  publisher_id: string
): Promise<{ source: string; material: MaterialUploadCompletionData }> {
  try {
    const materialBySourceSnapshot = await realtime
      .ref(`material-upload-completion/${publisher_id}/sources/${material_id}`)
      .once('value')

    const materialBySource: MaterialUploadCompletionBySource = materialBySourceSnapshot.val()
    if (!materialBySource) {
      throw Error(
        `[${getLatestMaterialFromRealtime.name}] No material found from publisher '${publisher_id}' with ID '${material_id}' in Realtime Database.`
      )
    }

    // Sort sources by 'update_time' and get the most recently updated material
    const [latestMaterial] = Object.entries(materialBySource)
      // extract source and material from each key-value pair,
      // and create a new object with the source and material properties.
      .map(([source, value]) => ({ source, material: value.material }))
      .sort((a, b) => b.material.update_time.localeCompare(a.material.update_time))

    if (!latestMaterial) {
      throw Error(
        `[${getLatestMaterialFromRealtime.name}] No latest material found for material '${material_id}'`
      )
    }

    return latestMaterial
  } catch (error) {
    throw Error(
      `[${getLatestMaterialFromRealtime.name}] Failed to retrieve data from Realtime Database for material '${material_id}': ${error}`
    )
  }
}

/**
 * Downloads an EPUB file from Firebase Storage to a temporary file location
 * @param material_id - ISBN of the material to be downloaded
 * @param storage_bucket - Firebase Storage bucket name
 * @param storage_path - Path to the file in Firebase Storage
 * @returns The path of the downloaded file
 */
async function downloadEpubFromStorage(
  material_id: string,
  storage_bucket: string,
  storage_path: string
): Promise<string> {
  // Extract file name from the 'storage_path' and create a temporary file path
  const fileName = path.basename(storage_path)
  const tempFilePath = path.join(os.tmpdir(), fileName)

  try {
    // Check if file exists in Firebase Storage before attempting to download it
    const file = storage.bucket(storage_bucket).file(storage_path)
    const [exists] = await file.exists()
    if (!exists) {
      throw Error(
        `[${downloadEpubFromStorage.name}] Material '${material_id}' not found at '${storage_path}'`
      )
    }

    // Download file from Firebase Storage to local temporary directory
    await file.download({ destination: tempFilePath })

    console.log(`[${downloadEpubFromStorage.name}] Downloaded '${fileName}' to '${tempFilePath}'`)
    return tempFilePath
  } catch (error) {
    throw Error(
      `[${downloadEpubFromStorage.name}] Failed to download file for material '${material_id}': ${error}`
    )
  }
}

/**
 * Uploads the analysis of the EPUB to Firebase Firestore.
 */
async function uploadEpubStatsToFirestore(
  publisher_id: string,
  material_id: string,
  source: string,
  analysis: Analysis
): Promise<void> {
  try {
    const type = 'analysis'
    const newId = `${source}__${type}`

    const newData = {
      type: type,
      source: source,
      data: analysis,
      updated_at: FieldValue.serverTimestamp(),
    }

    await firestore
      .collection(
        `/application/application_data/publishers/${publisher_id}/books/${material_id}/source_data/`
      )
      .doc(newId)
      .set(newData)
  } catch (error) {
    throw Error(
      `[${uploadEpubStatsToFirestore.name}] Failed to update Firestore with analysis for material '${material_id}': ${error}`
    )
  }
}

/**
 * Uploads the analysis results of an EPUB file to Firebase Realtime Database.
 */
async function uploadEpubStatsToRealtime(
  publisher_id: string,
  material_id: string,
  source: string,
  analysis: Analysis
): Promise<void> {
  try {
    await realtime.ref('/').update({
      [`material-upload-analysis/${publisher_id}/sources/${material_id}/${source}`]: analysis,
      [`material-upload-completion/${publisher_id}/sources/${material_id}/${source}/analysis/update_time`]:
        new Date().toISOString(),
    })
  } catch (error) {
    throw Error(
      `[${uploadEpubStatsToRealtime.name}] Failed to update Realtime Database with analysis for material '${material_id}': ${error}`
    )
  }
}
