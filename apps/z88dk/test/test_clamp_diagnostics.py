"""clamp_diagnostics (#217): the diagnostic block returned to the IDE is
bounded, but a warning-heavy build must not push the error lines past the
bound - zcc prints warnings as it meets them, so a tail truncation used to
eat exactly the lines the user needed. Pure-function tests: no toolchain
required."""
from app.routes.compile import clamp_diagnostics, DIAGNOSTICS_LIMIT


def make_warning(n):
    return f"program.c:{n}: warning 85: unreferenced local variable 'x{n}'"


ERROR_LINE = "program.c:900: error 101: too many parameters in call to 'f'"


def test_output_within_limit_passes_through_untouched():
    output = "\n".join([make_warning(1), ERROR_LINE])
    assert clamp_diagnostics(output) == output


def test_error_lines_survive_a_warning_flood():
    warnings = [make_warning(n) for n in range(200)]
    output = "\n".join(warnings + [ERROR_LINE])
    assert len(output) > DIAGNOSTICS_LIMIT

    clamped = clamp_diagnostics(output)
    assert ERROR_LINE in clamped
    assert "omitted" in clamped
    # Bounded: the full text plus the note, never the whole flood.
    assert len(clamped) < len(output)


def test_error_only_flood_still_bounded():
    errors = [f"program.c:{n}: error 101: too many parameters" for n in range(200)]
    output = "\n".join(errors)
    clamped = clamp_diagnostics(output)
    assert len(clamped) <= DIAGNOSTICS_LIMIT + len("\n... (truncated)")
    assert clamped.endswith("(truncated)")


def test_no_error_lines_falls_back_to_tail_truncation_with_marker():
    output = "\n".join(make_warning(n) for n in range(200))
    clamped = clamp_diagnostics(output)
    assert len(clamped) <= DIAGNOSTICS_LIMIT + len("\n... (truncated)")
    assert clamped.endswith("(truncated)")
    assert clamped.startswith(make_warning(0))
