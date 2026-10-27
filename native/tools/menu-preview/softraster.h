// Rift menu preview: draws ImGui output (ImDrawData) in software into an RGBA image.
// Only for screenshots outside the game - in the game DirectX 11/12 draws the same triangles.
#pragma once
#include "imgui.h"
#include <vector>
#include <cstdint>
#include <unordered_map>
#include <string>

struct SoftTexture
{
    int Width = 0, Height = 0;
    std::vector<uint8_t> Rgba; // 4 bytes per pixel
};

class SoftRaster
{
public:
    SoftRaster(int Width, int Height);
    void Clear(ImU32 Color);
    // Stores a texture under an id (e.g. the font atlas)
    ImTextureID AddTexture(SoftTexture Texture);
    // Handles ImGui 1.92 textures (dynamic font atlas)
    void UpdateTextures(ImDrawData* DrawData);
    void Render(ImDrawData* DrawData);
    bool SavePpm(const std::string& Path) const; // raw image, turned into a PNG by Python
    const std::vector<float>& Pixels() const { return Px; }
    int Width() const { return W; }
    int Height() const { return H; }
    // Copies an image (RGBA, straight alpha) in directly - for background screenshots
    void Blit(const std::vector<uint8_t>& Rgba, int Width, int Height);

private:
    int W, H;
    std::vector<float> Px; // RGB linear 0..1 (alpha is always 1 in the target)
    std::unordered_map<intptr_t, SoftTexture> Textures;
    intptr_t NextId = 1;
    void DrawTriangle(const ImDrawVert& A, const ImDrawVert& B, const ImDrawVert& C,
        const SoftTexture* Tex, const ImVec4& Clip);
};
