declare module 'zmakebas' {
    export interface ZmakebasMessage {
        type: 'out' | 'err';
        text: string;
    }

    /**
     * Compile ZX Spectrum BASIC source into a .tap tape image.
     * Resolves with the tape bytes. Rejects with an array of ZmakebasMessage
     * (the compiler's stderr) when the source fails to compile.
     */
    const zmakebas: (input: string, labelsMode?: boolean) => Promise<Uint8Array>;
    export default zmakebas;
}
