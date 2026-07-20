using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace SpriteSheetTools
{
    public sealed class ExtractionReport
    {
        public int Count { get; set; }
        public int Components { get; set; }
        public int DroppedComponents { get; set; }
        public int BlankCellComponents { get; set; }
        public string Warnings { get; set; }
        public string CellsDir { get; set; }
        public string PreviewPath { get; set; }
    }

    internal sealed class Component
    {
        public int Id;
        public int Count;
        public long SumX;
        public long SumY;
        public int MinX = Int32.MaxValue;
        public int MinY = Int32.MaxValue;
        public int MaxX = -1;
        public int MaxY = -1;
        public int Cell = -1;
    }

    public static class SpriteSheetExtractor
    {
        private const int SheetSize = 1020;
        private const int CellSize = 204;
        private const int GridSize = 5;
        private const int MinimumComponentPixels = 4;
        private const int MaximumSpriteExtent = 188;

        public static ExtractionReport Extract(
            string normalizedPath,
            string[] names,
            string cellsDir,
            string previewPath)
        {
            if (names == null || names.Length < 1 || names.Length > 25)
                throw new ArgumentException("names must contain 1..25 entries");

            Directory.CreateDirectory(cellsDir);
            var warnings = new List<string>();
            int droppedComponents = 0;
            int blankCellComponents = 0;

            using (var loaded = new Bitmap(normalizedPath))
            using (var sheet = new Bitmap(SheetSize, SheetSize, PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(sheet))
                {
                    graphics.Clear(Color.Transparent);
                    graphics.CompositingMode = CompositingMode.SourceCopy;
                    graphics.DrawImageUnscaled(loaded, 0, 0);
                }

                int width = sheet.Width;
                int height = sheet.Height;
                int pixelCount = width * height;
                var visible = new bool[pixelCount];
                var labels = new int[pixelCount];
                for (int index = 0; index < pixelCount; index++) labels[index] = -1;

                for (int y = 0; y < height; y++)
                {
                    for (int x = 0; x < width; x++)
                    {
                        visible[y * width + x] = sheet.GetPixel(x, y).A > 2;
                    }
                }

                var components = new List<Component>();
                var queue = new Queue<int>();
                for (int start = 0; start < pixelCount; start++)
                {
                    if (!visible[start] || labels[start] >= 0) continue;

                    var component = new Component { Id = components.Count };
                    labels[start] = component.Id;
                    queue.Enqueue(start);

                    while (queue.Count > 0)
                    {
                        int current = queue.Dequeue();
                        int x = current % width;
                        int y = current / width;
                        component.Count++;
                        component.SumX += x;
                        component.SumY += y;
                        if (x < component.MinX) component.MinX = x;
                        if (x > component.MaxX) component.MaxX = x;
                        if (y < component.MinY) component.MinY = y;
                        if (y > component.MaxY) component.MaxY = y;

                        for (int dy = -1; dy <= 1; dy++)
                        {
                            int nextY = y + dy;
                            if (nextY < 0 || nextY >= height) continue;
                            for (int dx = -1; dx <= 1; dx++)
                            {
                                if (dx == 0 && dy == 0) continue;
                                int nextX = x + dx;
                                if (nextX < 0 || nextX >= width) continue;
                                int next = nextY * width + nextX;
                                if (!visible[next] || labels[next] >= 0) continue;
                                labels[next] = component.Id;
                                queue.Enqueue(next);
                            }
                        }
                    }

                    components.Add(component);
                }

                var groups = new List<Component>[GridSize * GridSize];
                for (int index = 0; index < groups.Length; index++) groups[index] = new List<Component>();

                // Establish one large body component as the anchor for each grid cell.
                // Detached fins, sparkles, mist, hooks, and petals are then attached to
                // the nearest body rather than blindly clipped at mathematical cell edges.
                var principals = new Component[GridSize * GridSize];
                foreach (var component in components)
                {
                    if (component.Count < 100) continue;
                    double centerX = (double)component.SumX / component.Count;
                    double centerY = (double)component.SumY / component.Count;
                    int bestCell = 0;
                    double bestDistance = Double.MaxValue;
                    for (int cell = 0; cell < GridSize * GridSize; cell++)
                    {
                        int column = cell % GridSize;
                        int row = cell / GridSize;
                        double expectedX = column * CellSize + CellSize / 2.0;
                        double expectedY = row * CellSize + CellSize / 2.0;
                        double deltaX = centerX - expectedX;
                        double deltaY = centerY - expectedY;
                        double distance = deltaX * deltaX + deltaY * deltaY;
                        if (distance < bestDistance)
                        {
                            bestDistance = distance;
                            bestCell = cell;
                        }
                    }
                    if (principals[bestCell] == null || component.Count > principals[bestCell].Count)
                        principals[bestCell] = component;
                }

                for (int cell = 0; cell < names.Length; cell++)
                {
                    if (principals[cell] == null)
                        throw new InvalidOperationException("No principal body component found for cell " + (cell + 1) + ": " + names[cell]);
                }

                foreach (var component in components)
                {
                    if (component.Count < MinimumComponentPixels)
                    {
                        droppedComponents++;
                        continue;
                    }

                    double centerX = (double)component.SumX / component.Count;
                    double centerY = (double)component.SumY / component.Count;
                    int bestCell = 0;
                    double bestDistance = Double.MaxValue;
                    for (int cell = 0; cell < GridSize * GridSize; cell++)
                    {
                        var principal = principals[cell];
                        if (principal == null) continue;
                        double deltaX = centerX < principal.MinX
                            ? principal.MinX - centerX
                            : centerX > principal.MaxX ? centerX - principal.MaxX : 0.0;
                        double deltaY = centerY < principal.MinY
                            ? principal.MinY - centerY
                            : centerY > principal.MaxY ? centerY - principal.MaxY : 0.0;
                        double distance = deltaX * deltaX + deltaY * deltaY;
                        if (distance < bestDistance)
                        {
                            bestDistance = distance;
                            bestCell = cell;
                        }
                    }
                    component.Cell = bestCell;
                    groups[bestCell].Add(component);
                    if (bestCell >= names.Length && component.Count >= 20) blankCellComponents++;
                }

                for (int cell = 0; cell < names.Length; cell++)
                {
                    var group = groups[cell];
                    if (group.Count == 0)
                        throw new InvalidOperationException("No visible component assigned to cell " + (cell + 1) + ": " + names[cell]);

                    int minX = Int32.MaxValue;
                    int minY = Int32.MaxValue;
                    int maxX = -1;
                    int maxY = -1;
                    int majorComponents = 0;
                    foreach (var component in group)
                    {
                        if (component.Count >= 100) majorComponents++;
                        if (component.MinX < minX) minX = component.MinX;
                        if (component.MinY < minY) minY = component.MinY;
                        if (component.MaxX > maxX) maxX = component.MaxX;
                        if (component.MaxY > maxY) maxY = component.MaxY;
                    }

                    if (majorComponents != 1)
                        warnings.Add("major-components:" + names[cell] + "=" + majorComponents);

                    int sourceWidth = maxX - minX + 1;
                    int sourceHeight = maxY - minY + 1;
                    if (sourceWidth > 260 || sourceHeight > 260)
                        warnings.Add("large-group:" + names[cell] + "=" + sourceWidth + "x" + sourceHeight);

                    using (var source = new Bitmap(sourceWidth, sourceHeight, PixelFormat.Format32bppArgb))
                    {
                        for (int y = minY; y <= maxY; y++)
                        {
                            for (int x = minX; x <= maxX; x++)
                            {
                                int label = labels[y * width + x];
                                if (label < 0) continue;
                                var component = components[label];
                                if (component.Count < MinimumComponentPixels || component.Cell != cell) continue;
                                source.SetPixel(x - minX, y - minY, sheet.GetPixel(x, y));
                            }
                        }

                        double scale = Math.Min(1.0, Math.Min(
                            (double)MaximumSpriteExtent / sourceWidth,
                            (double)MaximumSpriteExtent / sourceHeight));
                        int destinationWidth = Math.Max(1, (int)Math.Round(sourceWidth * scale));
                        int destinationHeight = Math.Max(1, (int)Math.Round(sourceHeight * scale));
                        int destinationX = (CellSize - destinationWidth) / 2;
                        int destinationY = (CellSize - destinationHeight) / 2;

                        using (var output = new Bitmap(CellSize, CellSize, PixelFormat.Format32bppArgb))
                        {
                            output.SetResolution(96, 96);
                            using (var graphics = Graphics.FromImage(output))
                            {
                                graphics.Clear(Color.Transparent);
                                graphics.CompositingMode = CompositingMode.SourceCopy;
                                graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
                                graphics.PixelOffsetMode = PixelOffsetMode.Half;
                                graphics.SmoothingMode = SmoothingMode.None;
                                graphics.DrawImage(
                                    source,
                                    new Rectangle(destinationX, destinationY, destinationWidth, destinationHeight),
                                    0, 0, sourceWidth, sourceHeight,
                                    GraphicsUnit.Pixel);
                            }
                            output.Save(Path.Combine(cellsDir, names[cell]), ImageFormat.Png);
                        }
                    }
                }

                using (var preview = new Bitmap(SheetSize, SheetSize, PixelFormat.Format32bppArgb))
                {
                    preview.SetResolution(96, 96);
                    using (var graphics = Graphics.FromImage(preview))
                    {
                        graphics.Clear(Color.FromArgb(255, 248, 248, 246));
                        graphics.CompositingMode = CompositingMode.SourceOver;
                        for (int cell = 0; cell < names.Length; cell++)
                        {
                            using (var image = new Bitmap(Path.Combine(cellsDir, names[cell])))
                            {
                                graphics.DrawImageUnscaled(image, (cell % GridSize) * CellSize, (cell / GridSize) * CellSize);
                            }
                        }
                        using (var pen = new Pen(Color.FromArgb(255, 218, 218, 214), 1))
                        {
                            for (int index = 1; index < GridSize; index++)
                            {
                                int position = index * CellSize;
                                graphics.DrawLine(pen, position, 0, position, SheetSize - 1);
                                graphics.DrawLine(pen, 0, position, SheetSize - 1, position);
                            }
                        }
                    }
                    preview.Save(previewPath, ImageFormat.Png);
                }

                return new ExtractionReport
                {
                    Count = names.Length,
                    Components = components.Count,
                    DroppedComponents = droppedComponents,
                    BlankCellComponents = blankCellComponents,
                    Warnings = String.Join("; ", warnings.ToArray()),
                    CellsDir = cellsDir,
                    PreviewPath = previewPath
                };
            }
        }
    }
}
