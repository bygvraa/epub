import { initializeApp } from "firebase-admin/app";
initializeApp();

import { region } from 'firebase-functions';
import { handleAnalyzeEpubAPI, handleAnalyzeEpubTrigger } from "./handleAnalyzeEpub";

const europeFunctions = region('europe-west1');

export const AnalysisModule = {
    analyzeEpub: europeFunctions.database
        .ref((`material-upload-completion/{publisher_id}/sources/{material_id}/{source}/material`))
        .onWrite(handleAnalyzeEpubTrigger),

    analyseEpubAPI: europeFunctions.https
        .onCall(handleAnalyzeEpubAPI),
}