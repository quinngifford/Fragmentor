from contract import CleanTextInput, CleanTextOutput, CleanTextCaps


async def clean_text(value: CleanTextInput, caps: CleanTextCaps) -> CleanTextOutput:
    """Flatten one posting into the plain text that should be embedded."""
    raise NotImplementedError("Clean Text has no implementation yet.")
