// Emscripten's PROXY_TO_PTHREAD requires a main symbol even with INVOKE_RUN=0.
// Test runners invoke exported checks explicitly after initializing the module.
int main() { return 0; }
