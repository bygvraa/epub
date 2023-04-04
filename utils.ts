
export function getMedianWithStandardDeviation(array: number[], textStandardDeviation: number, standardDeviationCap: number): number {
    const sortedArr = array.slice().sort((a, b) => a - b);
    let midIndex = Math.floor(sortedArr.length / 2);

    const midVal = sortedArr[midIndex];
    const median   = Number(midVal.toPrecision(4));
    const stndDev  = Number(textStandardDeviation.toPrecision(4));

    if (textStandardDeviation > standardDeviationCap) {
        for (let i = 0; i < sortedArr.length; i++) {

            const lixValue = Number(sortedArr[i].toPrecision(4));

            if (sortedArr[i] >= (midVal + textStandardDeviation)) {
                console.log(` - removed LIX value '${lixValue}' - higher than '${(median + stndDev).toPrecision(4)}' (median ${median} + stnd. dev. ${stndDev})`);
                sortedArr.splice(i, 1);
                i--;
            }

            if (sortedArr[i] <= (midVal - textStandardDeviation)) {
                console.log(` - removed LIX value '${lixValue}' - lower than '${(median - stndDev).toPrecision(4)}' (median ${median} - stnd. dev. ${stndDev})`);
                sortedArr.splice(i, 1);
                i--;
            }
        }
        midIndex = Math.floor(sortedArr.length / 2);
    }

    if ((sortedArr.length % 2 === 0) && (sortedArr.length > 1)) {
        return ((sortedArr[midIndex - 1] + sortedArr[midIndex]) / 2);
    } else {
        return sortedArr[midIndex];
    }
}

export function getMedian(array: number[]): number {
    const sortedArr = array.slice().sort((a, b) => a - b);
    const midIndex = Math.floor(sortedArr.length / 2);

    if ((sortedArr.length % 2 === 0) && (sortedArr.length > 1)) {
        return ((sortedArr[midIndex - 1] + sortedArr[midIndex]) / 2);
    } else {
        return sortedArr[midIndex];
    }
}

export function getMean(array: number[]): number {
    const length = array.length;

    if(length == 0) {
        return 0;
    }

    const sum = (array.reduce((total, num) => total + num));
    const avg = (sum / length);

    return avg;
}

export function getStandardDeviation(array: number[]): number {
    const length = array.length;

    if(length == 0) {
        return 0;
    }

    const mean = (array.reduce((total, num) => total + num) / length);              // Find mean (average) of numbers in array
    const deviations = array.map(num => num - mean);                                // Find deviations from mean for each number in array
    const deviationsSq = deviations.map(devi => devi * devi);                       // Find squared deviations
    const variance = (deviationsSq.reduce((total, num) => total + num, 0)/ length); // Find variance by taking mean of squared deviations

    const standardDeviation = Math.sqrt(variance);                                  // Calculate standard deviation by squared variance

    return standardDeviation;
}

export function getUniqueStrings(strings: string[]): string[] {
    const uniqueStrings: string[] = [];

    for (const string of strings) {
        if (!uniqueStrings.includes(string.toLocaleLowerCase())) {
            uniqueStrings.push(string.toLocaleLowerCase())
        }
    }
    return uniqueStrings.sort((a, b) => a.localeCompare(b));
}

export function compareArrays(array1: string[], array2: string[]) {
    const uniqueValues: string[] = [];

    for (let i = 0; i < array1.length; i++) {
        if (array2.indexOf(array1[i]) === -1) {
            uniqueValues.push('only in new: ' + array1[i]);
        }
    }

    for (let i = 0; i < array2.length; i++) {
        if (array1.indexOf(array2[i]) === -1) {
            uniqueValues.push('only in old: ' + array2[i]);
        }
    }
    for (const value of uniqueValues)
        console.log(value);
}