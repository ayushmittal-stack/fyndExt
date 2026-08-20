import React from "react";
import { ExtensionExperience } from "./components/oms/ExtensionExperience";

const globalStyles = `
  html {
    height: 100%;
    width: 100%;
    font-size: 8px;
  }

  body {
    margin: 0;
    font-family: 'Inter', sans-serif;
    background-color: #f8f8f8 !important;
    width: 100%;
    height: 100%;
    -webkit-font-smoothing: antialiased;
  }

  .root {
    font-family: 'Inter', sans-serif;
  }
`;

function App() {
  return (
    <>
      <style>{globalStyles}</style>
      <div className="root">
        <ExtensionExperience />
      </div>
    </>
  );
}

export default App;
