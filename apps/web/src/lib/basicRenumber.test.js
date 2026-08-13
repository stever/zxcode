import {renumberBasicSource} from "./basicRenumber";

describe("renumberBasicSource", () => {
    it("renumbers lines to 10/20/30 and follows references", () => {
        const src = [
            "1 PRINT \"HI\"",
            "2 GO TO 1",
            "3 GOSUB 2: GOTO 3",
        ].join("\n");
        const r = renumberBasicSource(src);
        expect(r.error).toBeUndefined();
        expect(r.code).toBe([
            "10 PRINT \"HI\"",
            "20 GO TO 10",
            "30 GOSUB 20: GOTO 30",
        ].join("\n"));
        expect(r.count).toBe(3);
        expect(r.refsUpdated).toBe(3);
    });

    it("snaps a reference between lines to the next existing line", () => {
        const src = "10 GO TO 15\n20 STOP";
        expect(renumberBasicSource(src).code).toBe("10 GO TO 20\n20 STOP");
    });

    it("leaves references beyond the last line unchanged", () => {
        const src = "10 GO TO 9999\n20 STOP";
        expect(renumberBasicSource(src).code).toBe("10 GO TO 9999\n20 STOP");
    });

    it("rewrites RUN, RESTORE, LIST, LLIST and SAVE ... LINE arguments", () => {
        const src = [
            "5 RESTORE 7: RUN 5",
            "6 LIST 5: LLIST 7",
            "7 SAVE \"prog\" LINE 5",
        ].join("\n");
        expect(renumberBasicSource(src).code).toBe([
            "10 RESTORE 30: RUN 10",
            "20 LIST 10: LLIST 30",
            "30 SAVE \"prog\" LINE 10",
        ].join("\n"));
    });

    it("accepts fused and spaced keyword spellings", () => {
        const src = "5 GOTO7\n7 GO   SUB 5";
        expect(renumberBasicSource(src).code).toBe("10 GOTO20\n20 GO   SUB 10");
    });

    it("never touches string literals or REM comments", () => {
        const src = [
            "5 PRINT \"GO TO 5 NOW\"",
            "6 REM GO TO 5",
            "7 PRINT \"\"\"GO TO 5\"\"\": GO TO 5",
        ].join("\n");
        expect(renumberBasicSource(src).code).toBe([
            "10 PRINT \"GO TO 5 NOW\"",
            "20 REM GO TO 5",
            "30 PRINT \"\"\"GO TO 5\"\"\": GO TO 10",
        ].join("\n"));
    });

    it("does not mistake identifiers containing a keyword for a reference", () => {
        const src = "5 LET runner=7: LET alist=5\n7 GO TO 5";
        expect(renumberBasicSource(src).code).toBe(
            "10 LET runner=7: LET alist=5\n20 GO TO 10");
    });

    it("leaves computed and fractional targets alone", () => {
        const src = "5 GO TO n*10\n7 PAUSE 0: GO TO 5.5";
        expect(renumberBasicSource(src).code).toBe(
            "10 GO TO n*10\n20 PAUSE 0: GO TO 5.5");
    });

    it("does not rewrite the leading digits of a fractional target", () => {
        // The engine must not backtrack '150.5' into a match on '15'.
        const src = "100 PRINT 1\n200 PAUSE 5: GO TO 150.5\n300 STOP";
        expect(renumberBasicSource(src).code).toBe(
            "10 PRINT 1\n20 PAUSE 5: GO TO 150.5\n30 STOP");
    });

    it("leaves arithmetic and scientific expression targets whole", () => {
        const src = "5 GO TO 5+10\n7 GO SUB 5 * 2\n9 GO TO 10e2";
        expect(renumberBasicSource(src).code).toBe(
            "10 GO TO 5+10\n20 GO SUB 5 * 2\n30 GO TO 10e2");
    });

    it("does not mistake an identifier starting with rem for a comment", () => {
        const src = "10 LET remainder=0: GO TO 50\n50 STOP";
        expect(renumberBasicSource(src).code).toBe(
            "10 LET remainder=0: GO TO 20\n20 STOP");
    });

    it("honours zmakebas continuation rows when asked", () => {
        const src = [
            "5 PRINT \"a\": \\",
            "20 + 3: GO TO 5",
            "7 STOP",
        ].join("\n");
        const r = renumberBasicSource(src, {continuations: true});
        expect(r.code).toBe([
            "10 PRINT \"a\": \\",
            "20 + 3: GO TO 10",
            "20 STOP",
        ].join("\n"));
        expect(r.count).toBe(2);
    });

    it("treats a digit-led row as a new line without continuation handling", () => {
        const src = "5 PRINT 1\n20 GO TO 5";
        expect(renumberBasicSource(src).code).toBe("10 PRINT 1\n20 GO TO 10");
    });

    it("rewrites the txt2bas #autostart directive when asked, comments never", () => {
        const src = [
            "#program demo",
            "#autostart 7",
            "5 REM top",
            "7 GO TO 5",
        ].join("\n");
        const r = renumberBasicSource(src, {autostartDirective: true});
        expect(r.code).toBe([
            "#program demo",
            "#autostart 20",
            "10 REM top",
            "20 GO TO 10",
        ].join("\n"));
        // Without the option (zmakebas: # rows are comments) it is untouched.
        expect(renumberBasicSource(src).code).toContain("#autostart 7");
    });

    it("tightens the step when 10s do not fit", () => {
        const lines = [];
        for (let i = 0; i < 1500; i++) lines.push(`${i + 1} PRINT ${i}`);
        const r = renumberBasicSource(lines.join("\n"));
        expect(r.error).toBeUndefined();
        const rows = r.code.split("\n");
        expect(rows[0]).toBe("10 PRINT 0");
        expect(rows[1]).toBe("15 PRINT 1");
        expect(rows[1499]).toBe(`${10 + 1499 * 5} PRINT 1499`);
    });

    it("errors when there is nothing to renumber", () => {
        expect(renumberBasicSource("").error).toBeDefined();
        expect(renumberBasicSource("# just a comment\n").error).toBeDefined();
    });

    it("ignores leading numbers outside the 1-9999 line range", () => {
        const src = "10000 not a line\n5 GO TO 5";
        expect(renumberBasicSource(src).code).toBe("10000 not a line\n10 GO TO 10");
    });
});
