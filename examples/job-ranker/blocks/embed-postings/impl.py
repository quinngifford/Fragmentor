from contract import EmbedPostingsInput, EmbedPostingsOutput, EmbedPostingsCaps


async def embed_postings(value: EmbedPostingsInput, caps: EmbedPostingsCaps) -> EmbedPostingsOutput:
    """Turn job postings into vectors so they can be compared by similarity."""
    raise NotImplementedError("Embed Postings has no implementation yet.")
