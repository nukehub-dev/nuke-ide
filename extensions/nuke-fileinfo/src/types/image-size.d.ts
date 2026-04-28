declare module 'image-size' {
    export interface ISizeCalculationResult {
        width?: number;
        height?: number;
        orientation?: number;
        type?: string;
    }
    export function imageSize(input: string | Buffer): ISizeCalculationResult;
}
