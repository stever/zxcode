// pasmo and bas2tap ship no type declarations. They each default-export a
// function taking source text and resolving to the assembled TAP bytes.
declare module 'pasmo' {
    const compile: (asmInput: string) => Promise<Uint8Array>;
    export default compile;
}

declare module 'bas2tap' {
    const compile: (input: string) => Promise<Uint8Array>;
    export default compile;
}
