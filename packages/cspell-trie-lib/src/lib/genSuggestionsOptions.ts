import { CompoundWordsMethod } from './walker';

export interface GenSuggestionOptionsStrict {
    /**
     * Controls forcing compound words.
     * @default CompoundWordsMethod.NONE
     */
    compoundMethod?: CompoundWordsMethod;

    /**
     * ignore case when searching.
     */
    ignoreCase: boolean;

    /**
     * Maximum number of "edits" allowed.
     * 3 is a good number. Above 5 can be very slow.
     */
    changeLimit: number;
}

export type GenSuggestionOptions = Partial<GenSuggestionOptionsStrict>;

export interface SuggestionOptionsStrict extends GenSuggestionOptionsStrict {
    /**
     * Maximum number of suggestions to make.
     */
    numSuggestions: number;

    /**
     * Allow ties when making suggestions.
     * if `true` it is possible to have more than `numSuggestions`.
     */
    includeTies: boolean;

    /**
     * Time alloted in milliseconds to generate suggestions.
     */
    timeout: number;

    /**
     * Optional filter function.
     * return true to keep the candidate.
     */
    filter?: (word: string, cost: number) => boolean;
}

export type SuggestionOptions = Partial<SuggestionOptionsStrict>;

export const defaultGenSuggestionOptions: GenSuggestionOptionsStrict = {
    compoundMethod: CompoundWordsMethod.NONE,
    ignoreCase: true,
    changeLimit: 5,
};

export const defaultSuggestionOptions: SuggestionOptionsStrict = {
    ...defaultGenSuggestionOptions,
    numSuggestions: 8,
    includeTies: true,
    timeout: 5000,
};

type KeyMapOfGenSuggestionOptionsStrict = {
    [K in keyof GenSuggestionOptionsStrict]: K;
};

type KeyMapOfSuggestionOptionsStrict = {
    [K in keyof SuggestionOptionsStrict]: K;
};

const keyMapOfGenSuggestionOptionsStrict: KeyMapOfGenSuggestionOptionsStrict = {
    changeLimit: 'changeLimit',
    compoundMethod: 'compoundMethod',
    ignoreCase: 'ignoreCase',
} as const;

const keyMapOfSuggestionOptionsStrict: KeyMapOfSuggestionOptionsStrict = {
    ...keyMapOfGenSuggestionOptionsStrict,
    includeTies: 'includeTies',
    filter: 'filter',
    numSuggestions: 'numSuggestions',
    timeout: 'timeout',
};

/**
 * Create suggestion options using composition.
 * @param opts - partial options.
 * @returns Options - with defaults.
 */
export function createSuggestionOptions(...opts: SuggestionOptions[]): SuggestionOptionsStrict {
    const options = { ...defaultSuggestionOptions };
    const keys = Object.keys(keyMapOfSuggestionOptionsStrict) as (keyof SuggestionOptions)[];
    for (const opt of opts) {
        for (const key of keys) {
            assign(options, opt, key);
        }
    }
    return options;
}

function assign<T, K extends keyof T>(dest: T, src: Partial<T>, k: K) {
    dest[k] = src[k] ?? dest[k];
}
