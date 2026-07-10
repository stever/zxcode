import JSZip from "jszip";
import {joinProjectFilePath, mainFileName} from "../../lib/lang";

// Builds a ZIP of the whole project from the store's shapes: the main source
// under the fixed name the compile services use (program.asm / program.bas /
// ...), plus every additional project file under its folder path (JSZip turns
// slashes in entry names into archive directories). Binary assets are decoded
// from base64 so the archive holds raw bytes. Current draft content is used,
// matching copy/compile. Names stemmed 'program' are reserved for the main
// source (lib/lang.js), so an additional file can never collide with it.
export function buildProjectZip(lang, code, files) {
    const zip = new JSZip();

    zip.file(mainFileName(lang), code || '');

    for (const file of files || []) {
        // noinspection JSDeprecatedSymbols
        zip.file(joinProjectFilePath(file.folder, file.name), file.isBinary
            ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
            : file.content);
    }

    return zip;
}
