const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
  } = require("@google/generative-ai");
  
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-8b",
  });
  
  const generationConfig = {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
  };
  
  const SUMMARY_PROMPT = `Extract the key points from this video transcription.
      Format your response as numbered points:
      1. Point one
      2. Point two

      Requirements:
      - Each point should be 1-2 lines maximum
      - Include only the most important information
      - No bullet points or special characters
      - No explanatory text or transitions`;

  const MEETING_PROMPT = `Write meeting notes from this meeting recording transcription.
      Use exactly these section headings, each on its own line:
      Summary
      Key Decisions
      Action Items
      Open Questions

      Requirements:
      - Under Summary, write 2-4 sentences
      - Under the other headings, write numbered points of 1-2 lines each
      - For each action item, include the owner and deadline if they were mentioned
      - Write "None" under a heading when nothing applies
      - Only include what was actually said in the meeting
      - Plain text only, no markdown, bullet points or special characters`;

  async function generateSummary(text, mode) {
    try {
      const prompt = `${mode === "meeting" ? MEETING_PROMPT : SUMMARY_PROMPT}

      Transcription:
      ${text}`;
  
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return {
        summary: response.text()
      };
    } catch (error) {
      console.error("Error generating summary:", error);
      return { error: error.message };
    }
  }
  
  // The JSON-encoded text arrives on stdin; the mode ("summary" or "meeting") is the first argument
  const stdin = require("fs").readFileSync(0, "utf8");
  const inputText = stdin.trim() ? JSON.parse(stdin) : "";
  generateSummary(inputText, process.argv[2])
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => console.error(JSON.stringify({ error: error.message })));