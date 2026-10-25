// Vanity Menü-Vorschau: zeichnet ImGui-Ausgabe (ImDrawData) per Software in ein RGBA-Bild.
// Nur für Screenshots außerhalb des Spiels – im Spiel zeichnet DirectX 11/12 dieselben Dreiecke.
#pragma once
#include "imgui.h"
#include <vector>
#include <cstdint>
#include <unordered_map>
#include <string>

struct SoftTexture
{
    int Width = 0, Height = 0;
    std::vector<uint8_t> Rgba; // 4 Bytes je Pixel
};

class SoftRaster
{
public:
    SoftRaster(int Width, int Height);
    void Clear(ImU32 Color);
    // Textur unter einer ID ablegen (z. B. Schrift-Atlas)
    ImTextureID AddTexture(SoftTexture Texture);
    // ImGui-1.92-Texturen (dynamischer Schrift-Atlas) verarbeiten
    void UpdateTextures(ImDrawData* DrawData);
    void Render(ImDrawData* DrawData);
    bool SavePpm(const std::string& Path) const; // Rohbild, wird per Python zu PNG
    const std::vector<float>& Pixels() const { return Px; }
    int Width() const { return W; }
    int Height() const { return H; }
    // Bild (RGBA, gerade Alpha) direkt einkopieren – für Hintergrund-Screenshots
    void Blit(const std::vector<uint8_t>& Rgba, int Width, int Height);

private:
    int W, H;
    std::vector<float> Px; // RGB linear 0..1 (Alpha immer 1 im Ziel)
    std::unordered_map<intptr_t, SoftTexture> Textures;
    intptr_t NextId = 1;
    void DrawTriangle(const ImDrawVert& A, const ImDrawVert& B, const ImDrawVert& C,
        const SoftTexture* Tex, const ImVec4& Clip);
};
