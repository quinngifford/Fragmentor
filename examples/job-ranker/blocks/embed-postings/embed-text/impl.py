from contract import EmbedTextInput, EmbedTextOutput, EmbedTextCaps


async def embed_text(value: EmbedTextInput, caps: EmbedTextCaps) -> EmbedTextOutput:
    """Turn one piece of text into a vector using the named model."""
    raise NotImplementedError("Embed Text has no implementation yet.")
